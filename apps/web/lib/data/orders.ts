import { Prisma, prismaForTenant } from "@wezesha/db";
import { buildPoDocument, isPoLate, type PoDocumentData } from "@/lib/po/po-model";
import { computeSupplierScore, type SupplierScore } from "@/lib/po/supplier-stats";

/**
 * Orders-screen queries. Server-only: every function takes an explicit
 * tenantId and runs on the RLS-enforced tenant client — no query here can
 * read another tenant's rows even if a `where` is wrong.
 *
 * Cost fields are redacted here, not at render: every getter that returns KES
 * cost figures takes an explicit `canViewCosts` and nulls those figures when it
 * is false, so a money-blind member's payload never carries the numbers —
 * supplier unit costs, PO line totals and subtotals all come back null and
 * render as the mask. What a staff member needs to receive a delivery (PO
 * number, quantities, supplier, status, dates) stays visible either way.
 * getPoDocument is the on-screen printable view, so it redacts too; the
 * supplier email is a separate, send-authorised path (lib/po/send-po.ts) that
 * always carries costs.
 */

// ── The screen's state, as the URL ───────────────────────────────────────────

/**
 * Orders is two lists on one screen, so it carries TWO page numbers.
 *
 * A single `page` would mean turning to older purchase orders also scrolls the
 * order queue away — two unrelated lists moving because the reader touched one
 * of them. They get a param each, and every link writes both, so paging one
 * leaves the other exactly where it was.
 *
 * Only the purchase orders are searchable. The queue is this week's buying,
 * grouped by supplier and read whole; the purchase-order list is the one that
 * keeps growing, and "find that order" is a question only it is ever asked.
 *
 * A hand-edited or stale value falls back to the default rather than throwing.
 */

/** Both page params are 1-based in the URL (people read pages from 1), 0-based
 *  inside. */
const PO_PAGE_PARAM = "page";
const QUEUE_PAGE_PARAM = "queue";
const SEARCH_PARAM = "q";

/** Long enough for anything a shop types, short enough that a pasted essay
 *  cannot turn one request into a scan for fifty terms. */
const SEARCH_MAX = 120;

export type OrdersQuery = {
  /** Free text over the purchase orders, already trimmed. Empty means no filter. */
  search: string;
  /** 0-based page of the purchase-order list. */
  poPage: number;
  /** 0-based page of the order queue. */
  queuePage: number;
};

export const DEFAULT_ORDERS_QUERY: OrdersQuery = { search: "", poPage: 0, queuePage: 0 };

/** What Next hands a page: a value may be absent, single, or repeated. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function one(params: RawSearchParams, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

function pageOf(params: RawSearchParams, key: string): number {
  const n = Number(one(params, key) ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) - 1 : 0;
}

export function parseOrdersQuery(params: RawSearchParams): OrdersQuery {
  return {
    search: (one(params, SEARCH_PARAM) ?? "").trim().slice(0, SEARCH_MAX),
    poPage: pageOf(params, PO_PAGE_PARAM),
    queuePage: pageOf(params, QUEUE_PAGE_PARAM),
  };
}

/** The query as a querystring, defaults omitted so an untouched screen has a
 *  clean `/orders` URL and every param present means the reader chose it. */
export function ordersQueryToSearch(q: OrdersQuery): string {
  const out = new URLSearchParams();
  if (q.search) out.set(SEARCH_PARAM, q.search);
  if (q.poPage > 0) out.set(PO_PAGE_PARAM, String(q.poPage + 1));
  if (q.queuePage > 0) out.set(QUEUE_PAGE_PARAM, String(q.queuePage + 1));
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** The query as hidden form fields, minus the text and the list's own page. A
 *  GET form submits only its own inputs, so without these a search would send
 *  the reader back to the first page of the QUEUE too — a list they weren't
 *  searching. Built from the same serializer the links use, so the two can't
 *  drift. */
export function ordersQueryFields(q: OrdersQuery): { name: string; value: string }[] {
  const search = ordersQueryToSearch({ ...q, search: "", poPage: 0 });
  return [...new URLSearchParams(search.replace(/^\?/, ""))].map(([name, value]) => ({
    name,
    value,
  }));
}

/** A changed query. Searching narrows WHICH orders match, so it starts the
 *  purchase-order list again at page 1 — a reader sitting on page 3 would
 *  otherwise land past the end of a one-page result. Paging passes its own page
 *  and keeps it, and neither list disturbs the other. */
export function withOrdersQuery(q: OrdersQuery, patch: Partial<OrdersQuery>): OrdersQuery {
  const next = { ...q, ...patch };
  if (patch.search !== undefined && patch.poPage === undefined) next.poPage = 0;
  return next;
}

/** Clamp to a real page. What survives a reader coming back to a bookmarked
 *  page 4 of a list that has since been narrowed, or delivered and archived. */
function pageBounds(
  total: number,
  page: number,
  size: number
): { pageCount: number; current: number; start: number } {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return { pageCount, current, start: current * size };
}

// ── Supplier scorecards ──────────────────────────────────────────────────────

/** Per-supplier delivery scores, derived from sent PO history at read time
 *  (see lib/po/supplier-stats.ts for why these are never tallied). */
export async function getSupplierScores(
  tenantId: string
): Promise<Map<string, SupplierScore>> {
  const db = prismaForTenant(tenantId);
  const pos = await db.purchaseOrder.findMany({
    where: { deletedAt: null, sentAt: { not: null }, supplierId: { not: null } },
    select: {
      supplierId: true,
      sentAt: true,
      expectedAt: true,
      receivedAt: true,
      lines: { select: { quantity: true, receivedQty: true } },
    },
  });
  const bySupplier = new Map<string, typeof pos>();
  for (const po of pos) {
    const list = bySupplier.get(po.supplierId!) ?? [];
    list.push(po);
    bySupplier.set(po.supplierId!, list);
  }
  const scores = new Map<string, SupplierScore>();
  for (const [supplierId, list] of bySupplier) {
    scores.set(supplierId, computeSupplierScore(list));
  }
  return scores;
}

// ── Order queue (pending buys, grouped by supplier) ──────────────────────────

export type OrderQueueLine = {
  orderId: string;
  productId: string;
  sku: string;
  title: string;
  qty: number;
  /** Null when the caller can't view costs. */
  unitCostKes: number | null;
  /** qty x unit cost. Null when the caller can't view costs. */
  lineCostKes: number | null;
  onHandUnits: number;
};

export type OrderQueueGroup = {
  /** null = products with no supplier assigned (can't be put on a PO yet). */
  supplierId: string | null;
  supplierName: string | null;
  moq: number | null;
  leadTimeAvgDays: number | null;
  /** Supplier scorecard — counts, percentages and lead-days only, no money. */
  score: SupplierScore | null;
  lines: OrderQueueLine[];
  totalUnits: number;
  /** Cost of ordering this group. Null when the caller can't view costs. */
  totalCostKes: number | null;
};

/** A group before redaction — built and totalled on real costs. */
type FullQueueGroup = OrderQueueGroup & {
  lines: (OrderQueueLine & { unitCostKes: number; lineCostKes: number })[];
  totalCostKes: number;
};

/** Pending Order rows grouped per supplier — the "what to buy" queue the
 *  Create PO action consumes. Queue rows arrive from the planner's
 *  add-to-order and the forecast's auto-queue as those flows land. Groups are
 *  built (and sorted) on full costs, then redacted, so a money-blind member
 *  sees the same suppliers and quantities with only the KES figures gone. */
export async function getOrderQueue(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<OrderQueueGroup[]> {
  const db = prismaForTenant(tenantId);
  const [orders, scores] = await Promise.all([
    db.order.findMany({
      where: { status: "pending", productId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, orderedQty: true, productId: true },
    }),
    getSupplierScores(tenantId),
  ]);
  // Order.productId is a bare column (no FK) — resolve the products separately.
  const products = await db.product.findMany({
    where: { id: { in: orders.map((o) => o.productId!) } },
    select: {
      id: true,
      sku: true,
      title: true,
      costKes: true,
      currentStock: true,
      supplierId: true,
      supplier: { select: { id: true, name: true, moq: true, leadTimeAvgDays: true } },
    },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const groups = new Map<string, FullQueueGroup>();
  for (const order of orders) {
    const product = productById.get(order.productId!);
    if (!product) continue;
    const key = product.supplierId ?? "unassigned";
    let group = groups.get(key);
    if (!group) {
      group = {
        supplierId: product.supplierId,
        supplierName: product.supplier?.name ?? null,
        moq: product.supplier?.moq ?? null,
        leadTimeAvgDays: product.supplier?.leadTimeAvgDays ?? null,
        score: product.supplierId ? (scores.get(product.supplierId) ?? null) : null,
        lines: [],
        totalUnits: 0,
        totalCostKes: 0,
      };
      groups.set(key, group);
    }
    const qty = order.orderedQty ?? 1;
    const lineCostKes = qty * product.costKes;
    group.lines.push({
      orderId: order.id,
      productId: product.id,
      sku: product.sku,
      title: product.title,
      qty,
      unitCostKes: product.costKes,
      lineCostKes,
      onHandUnits: product.currentStock,
    });
    group.totalUnits += qty;
    group.totalCostKes += lineCostKes;
  }

  // Suppliers alphabetically; the unassigned bucket last.
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.supplierId === null) return 1;
    if (b.supplierId === null) return -1;
    return (a.supplierName ?? "").localeCompare(b.supplierName ?? "");
  });
  if (canViewCosts) return sorted;
  return sorted.map((group) => ({
    ...group,
    totalCostKes: null,
    lines: group.lines.map((line) => ({ ...line, unitCostKes: null, lineCostKes: null })),
  }));
}

/** Supplier cards on one page of the queue. A card is a table with its own
 *  scorecard and Create PO button, not a row, so five of them is already a long
 *  screen. */
export const QUEUE_PAGE_SIZE = 5;

export type OrderQueuePage = {
  groups: OrderQueueGroup[];
  /** Suppliers with something queued — what the pager counts against. */
  total: number;
  page: number;
  pageCount: number;
  /** 1-based position of the first card on the page; 0 when there are none. */
  from: number;
};

/**
 * One page of the queue, counted whole cards.
 *
 * The page boundary falls BETWEEN suppliers, never inside one. A card is the
 * unit the reader works with — they tick its lines, read its running total and
 * turn it into a single purchase order — so half a supplier on one page and half
 * on the next would be an order that quietly leaves stock behind.
 *
 * Sliced rather than paged in SQL because the groups only exist after the queued
 * rows are resolved to products and gathered by supplier: the number of cards is
 * not something the database can count without doing all of that first.
 */
export async function getOrderQueuePage(
  tenantId: string,
  { canViewCosts, page }: { canViewCosts: boolean; page: number }
): Promise<OrderQueuePage> {
  const groups = await getOrderQueue(tenantId, { canViewCosts });
  const { pageCount, current, start } = pageBounds(groups.length, page, QUEUE_PAGE_SIZE);
  return {
    groups: groups.slice(start, start + QUEUE_PAGE_SIZE),
    total: groups.length,
    page: current,
    pageCount,
    from: groups.length === 0 ? 0 : start + 1,
  };
}

// ── Purchase order list + detail ─────────────────────────────────────────────

export type PoListRow = {
  id: string;
  poNumber: string;
  status: string;
  supplierName: string | null;
  lineCount: number;
  totalUnits: number;
  receivedUnits: number;
  /** PO value. Null when the caller can't view costs. */
  subtotalKes: number | null;
  createdAt: Date;
  sentAt: Date | null;
  expectedAt: Date | null;
  receivedAt: Date | null;
  /** Promised day passed with stock still outstanding (lib/po/po-model.ts). */
  isLate: boolean;
};

const PO_LIST_SELECT = {
  id: true,
  poNumber: true,
  status: true,
  subtotalKes: true,
  createdAt: true,
  sentAt: true,
  expectedAt: true,
  receivedAt: true,
  supplier: { select: { name: true } },
  lines: { select: { quantity: true, receivedQty: true } },
} satisfies Prisma.PurchaseOrderSelect;

type PoListSelected = Prisma.PurchaseOrderGetPayload<{ select: typeof PO_LIST_SELECT }>;

/** The row as the database has it. Redaction stays in the getter below, in
 *  plain sight: the cost-surface scan reads exported bodies, so a getter that
 *  hands its masking to a helper drops off the manifest that guards it. */
function toPoListRow(po: PoListSelected, now: Date): PoListRow {
  return {
    id: po.id,
    poNumber: po.poNumber,
    status: po.status,
    supplierName: po.supplier?.name ?? null,
    lineCount: po.lines.length,
    totalUnits: po.lines.reduce((s, l) => s + l.quantity, 0),
    receivedUnits: po.lines.reduce((s, l) => s + l.receivedQty, 0),
    subtotalKes: po.subtotalKes,
    createdAt: po.createdAt,
    sentAt: po.sentAt,
    expectedAt: po.expectedAt,
    receivedAt: po.receivedAt,
    isLate: isPoLate(po, now),
  };
}

/** Newest first. Id breaks a timestamp tie: without it two orders created in the
 *  same millisecond can swap places between requests, which on a page boundary
 *  shows one of them twice and hides the other. */
const PO_LIST_ORDER = [
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.PurchaseOrderOrderByWithRelationInput[];

/** Purchase orders on one page. The list is read once a week rather than
 *  scanned, so a page is a month or two of ordering: enough to see the recent
 *  run in one go, few enough that the page stops growing with the years. */
export const PO_PAGE_SIZE = 20;

/**
 * What a search term is matched against: the order's number, its supplier, and
 * the products on it — the three things someone hunting an order remembers. The
 * number is the exact handle (unique per workspace), the supplier is what they
 * say out loud, and the product is what they were after when they recalled
 * neither.
 *
 * Costs stay out of it: a search that matched a figure would let a money-blind
 * member confirm one by watching the match count move.
 *
 * Terms are ANDed: "haria lotion" means both, in any order.
 */
function poSearchFilter(search: string): Prisma.PurchaseOrderWhereInput[] {
  return search
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      const contains = { contains: term, mode: "insensitive" as const };
      return {
        OR: [
          { poNumber: contains },
          { supplier: { name: contains } },
          { lines: { some: { OR: [{ title: contains }, { sku: contains }] } } },
        ],
      };
    });
}

/** The one place the rows and the count agree on what the reader asked for. */
function poListWhere(search: string): Prisma.PurchaseOrderWhereInput {
  const filters = poSearchFilter(search);
  return { deletedAt: null, ...(filters.length ? { AND: filters } : {}) };
}

/** How many live orders the reader's search matches — the whole list, not the
 *  page. What the pager counts against, so "showing 1–20 of 26" is honest. */
export async function countPurchaseOrders(
  tenantId: string,
  { search = "" }: { search?: string } = {}
): Promise<number> {
  const db = prismaForTenant(tenantId);
  return db.purchaseOrder.count({ where: poListWhere(search) });
}

/** Clamp to a real page. What survives a reader coming back to a bookmarked
 *  page 4 of a list that has since been narrowed by a search. */
export function poListPageBounds(
  total: number,
  page: number
): { pageCount: number; current: number; start: number } {
  return pageBounds(total, page, PO_PAGE_SIZE);
}

export async function getPurchaseOrders(
  tenantId: string,
  { canViewCosts, search = "", page }: {
    canViewCosts: boolean;
    search?: string;
    /** 0-based. Omitted returns the whole list. */
    page?: number;
  }
): Promise<PoListRow[]> {
  const db = prismaForTenant(tenantId);
  const pos = await db.purchaseOrder.findMany({
    where: poListWhere(search),
    orderBy: PO_LIST_ORDER,
    ...(page === undefined
      ? {}
      : { skip: Math.max(0, page) * PO_PAGE_SIZE, take: PO_PAGE_SIZE }),
    select: PO_LIST_SELECT,
  });
  const now = new Date();
  return pos.map((po) => {
    const row = toPoListRow(po, now);
    return canViewCosts ? row : { ...row, subtotalKes: null };
  });
}

export type PoDetailLine = {
  id: string;
  productId: string;
  sku: string;
  title: string;
  quantity: number;
  /** Null when the caller can't view costs. */
  unitCostKes: number | null;
  lineTotalKes: number | null;
  receivedQty: number;
  receivedAt: Date | null;
};

/**
 * What the email ledger says about the supplier's copy of an order.
 *
 * EmailLog carries no purchaseOrderId, so the rows have to be found by
 * something already on them. The PO number is that something: it is unique per
 * workspace (PurchaseOrder @@unique([tenantId, poNumber])) and the send path
 * puts it in the subject, so the match is exact rather than a guess from
 * timestamps and addresses — two orders emailed to the same supplier in the
 * same minute stay distinguishable. RLS confines the search to this workspace.
 *
 * The trade is that this read depends on the subject the send path writes. The
 * po-email-outcome suite pins that format, so a change to it fails a test
 * rather than quietly blanking the screen.
 */
export type PoEmailOutcome = {
  /** The last attempt's ledger status: sent | failed | skipped. */
  status: string;
  /** Address the send was addressed to. */
  to: string;
  at: Date;
  /** Attempts before this one — a retry after a failure leaves both rows. */
  earlierAttempts: number;
};

/** The fragment of a PO email's subject that identifies the order. Spaces on
 *  both sides so PO-9 doesn't match PO-90. */
export function poEmailLogSubjectMatch(poNumber: string): string {
  return ` ${poNumber} `;
}

export type PoDetail = {
  id: string;
  poNumber: string;
  status: string;
  currency: string;
  /** PO value. Null when the caller can't view costs. */
  subtotalKes: number | null;
  createdAt: Date;
  sentAt: Date | null;
  expectedAt: Date | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  /** Promised day passed with stock still outstanding (lib/po/po-model.ts). */
  isLate: boolean;
  createdByName: string | null;
  /** Who emailed it to the supplier. Read from the ledger rather than a column
   *  on the order: sending is recorded there already, and a denormalised copy
   *  would be a second place for the same fact to drift. Null for an order sent
   *  before the send started naming its actor. */
  sentByName: string | null;
  /** What happened to the supplier's email, from the ledger. Null when no
   *  attempt was ever recorded for this order. */
  email: PoEmailOutcome | null;
  supplier: {
    id: string;
    name: string;
    email: string | null;
    leadTimeAvgDays: number | null;
  } | null;
  lines: PoDetailLine[];
  totalUnits: number;
  receivedUnits: number;
  /** Receiving destinations, primary first — the location picker's options. */
  locations: { id: string; name: string; isPrimary: boolean }[];
};

export async function getPoDetail(
  tenantId: string,
  poId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<PoDetail | null> {
  const db = prismaForTenant(tenantId);
  const [po, locations, sentEvent] = await Promise.all([
    db.purchaseOrder.findFirst({
      where: { id: poId, deletedAt: null },
      select: {
        id: true,
        poNumber: true,
        status: true,
        currency: true,
        subtotalKes: true,
        createdAt: true,
        sentAt: true,
        expectedAt: true,
        receivedAt: true,
        cancelledAt: true,
        createdByName: true,
        supplier: {
          select: { id: true, name: true, email: true, leadTimeAvgDays: true },
        },
        lines: {
          orderBy: { title: "asc" },
          select: {
            id: true,
            productId: true,
            sku: true,
            title: true,
            quantity: true,
            unitCostKes: true,
            lineTotalKes: true,
            receivedQty: true,
            receivedAt: true,
          },
        },
      },
    }),
    db.location.findMany({
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isPrimary: true },
    }),
    db.auditEvent.findFirst({
      where: { entity: "PurchaseOrder", entityId: poId, action: "ordered" },
      orderBy: { createdAt: "desc" },
      select: { actorName: true },
    }),
  ]);
  if (!po) return null;

  const attempts = await db.emailLog.findMany({
    where: {
      kind: "purchase_order",
      subject: { contains: poEmailLogSubjectMatch(po.poNumber) },
    },
    orderBy: { createdAt: "desc" },
    select: { status: true, to: true, createdAt: true },
  });
  const latest = attempts[0];

  return {
    ...po,
    sentByName: sentEvent?.actorName ?? null,
    email: latest
      ? {
          status: latest.status,
          to: latest.to,
          at: latest.createdAt,
          earlierAttempts: attempts.length - 1,
        }
      : null,
    isLate: isPoLate(po, new Date()),
    subtotalKes: canViewCosts ? po.subtotalKes : null,
    lines: po.lines.map((line) =>
      canViewCosts ? line : { ...line, unitCostKes: null, lineTotalKes: null }
    ),
    totalUnits: po.lines.reduce((s, l) => s + l.quantity, 0),
    receivedUnits: po.lines.reduce((s, l) => s + l.receivedQty, 0),
    locations,
  };
}

/** The PO shaped for the on-screen printable document. Redacts costs for a
 *  money-blind member — the supplier email builds its own copy with costs on
 *  the send-authorised path (lib/po/send-po.ts), independent of the viewer. */
export async function getPoDocument(
  tenantId: string,
  poId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<PoDocumentData | null> {
  const db = prismaForTenant(tenantId);
  const [po, tenant] = await Promise.all([
    db.purchaseOrder.findFirst({
      where: { id: poId, deletedAt: null },
      select: {
        poNumber: true,
        status: true,
        createdAt: true,
        sentAt: true,
        expectedAt: true,
        currency: true,
        subtotalKes: true,
        createdByName: true,
        supplier: { select: { name: true, email: true, country: true } },
        lines: {
          orderBy: { title: "asc" },
          select: { sku: true, title: true, quantity: true, unitCostKes: true, lineTotalKes: true },
        },
      },
    }),
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);
  if (!po || !tenant) return null;
  return buildPoDocument(po, tenant.name, { canViewCosts });
}
