import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { computeSupplierScore, type OnTimeStatus } from "@/lib/po/supplier-stats";
import {
  leadTimeDrift,
  learnedLeadMedianDays,
  shortShipRatePct,
  speedBand,
  type LeadTimeDrift,
  type SpeedBand,
} from "@/lib/suppliers/lead-time";
import { suggestSupplierForVendor, type SupplierLite } from "@/lib/suppliers/assign";

/**
 * Suppliers-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout — no query here can read another tenant's rows even if a
 * `where` is wrong.
 *
 * Supplier figures carry no KES cost (MOQ is units, currency is a code, lead
 * times are days), so nothing here is money-blind gated. The learned lead time,
 * short-ship rate and drift flag are all derived from PO receipt history at read
 * time; the typed lead time stays exactly what the owner set (a received
 * delivery never overwrites it — see lib/po/receive-po.ts).
 */

export type SupplierRow = {
  id: string;
  name: string;
  group: string | null;
  country: string | null;
  currency: string;
  email: string | null;
  moq: number;
  /** Owner-set lead time (Supplier.leadTimeAvgDays). null = never set. */
  leadTimeTypedDays: number | null;
  leadTimeStdDays: number;
  /** Median actual lead over the last N deliveries; null below the minimum. */
  learnedLeadDays: number | null;
  /** Completed deliveries scored (deliveredPos). */
  deliveriesTracked: number;
  onTimePct: number | null;
  /** Why onTimePct is null — the row says so rather than leaving a gap. */
  onTimeStatus: OnTimeStatus;
  fillRatePct: number | null;
  shortShipPct: number | null;
  assignedProductCount: number;
  /** Derived from the typed lead time, or the learned one when typed is unset. */
  speedBand: SpeedBand | null;
  drift: LeadTimeDrift;
};

type ScorePo = {
  supplierId: string | null;
  sentAt: Date | null;
  expectedAt: Date | null;
  receivedAt: Date | null;
  lines: { quantity: number; receivedQty: number }[];
};

export async function getSuppliers(tenantId: string): Promise<SupplierRow[]> {
  const db = prismaForTenant(tenantId);
  const [suppliers, productCounts, pos] = await Promise.all([
    db.supplier.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        supplierGroup: true,
        country: true,
        currency: true,
        email: true,
        moq: true,
        leadTimeAvgDays: true,
        leadTimeStdDays: true,
      },
    }),
    db.product.groupBy({
      by: ["supplierId"],
      where: { supplierId: { not: null } },
      _count: { _all: true },
    }),
    db.purchaseOrder.findMany({
      where: { deletedAt: null, sentAt: { not: null }, supplierId: { not: null } },
      select: {
        supplierId: true,
        sentAt: true,
        expectedAt: true,
        receivedAt: true,
        lines: { select: { quantity: true, receivedQty: true } },
      },
    }),
  ]);

  const countBySupplier = new Map(
    productCounts.map((c) => [c.supplierId!, c._count._all]),
  );
  const posBySupplier = new Map<string, ScorePo[]>();
  for (const po of pos as ScorePo[]) {
    const list = posBySupplier.get(po.supplierId!) ?? [];
    list.push(po);
    posBySupplier.set(po.supplierId!, list);
  }

  return suppliers.map((s) => {
    const supplierPos = posBySupplier.get(s.id) ?? [];
    const score = computeSupplierScore(supplierPos);
    const completed = supplierPos
      .filter((po) => po.sentAt != null && po.receivedAt != null)
      .map((po) => ({ sentAt: po.sentAt!, receivedAt: po.receivedAt! }));
    const learnedLeadDays = learnedLeadMedianDays(completed);
    const typed = s.leadTimeAvgDays;
    return {
      id: s.id,
      name: s.name,
      group: s.supplierGroup,
      country: s.country,
      currency: s.currency,
      email: s.email,
      moq: s.moq,
      leadTimeTypedDays: typed,
      leadTimeStdDays: s.leadTimeStdDays,
      learnedLeadDays,
      deliveriesTracked: score.deliveredPos,
      onTimePct: score.onTimePct,
      onTimeStatus: score.onTimeStatus,
      fillRatePct: score.fillRatePct,
      shortShipPct: shortShipRatePct(supplierPos),
      assignedProductCount: countBySupplier.get(s.id) ?? 0,
      speedBand: speedBand(typed ?? learnedLeadDays),
      drift: leadTimeDrift(typed, learnedLeadDays),
    };
  });
}

// ── The suppliers list: search, sort, page ───────────────────────────────────

/**
 * Suppliers on one page. The list grows by one every time a brand changes
 * hands, and these rows run two and three lines tall — 25 is about a screenful,
 * and the pager says how much is left rather than leaving the reader to guess.
 */
export const SUPPLIERS_PAGE_SIZE = 25;

export const SUPPLIER_SORT_KEYS = [
  "name",
  "group",
  "leadTyped",
  "learned",
  "moq",
  "products",
  "onTime",
] as const;
export type SupplierSortKey = (typeof SUPPLIER_SORT_KEYS)[number];

/** Everything the screen filters and sorts by. Each one changes WHICH suppliers
 *  match, so each one also sends the reader back to page 1. */
export type SupplierQuery = {
  /** Free text, already trimmed. Empty means no filter. */
  search: string;
  sortKey: SupplierSortKey;
  desc: boolean;
  page: number;
};

export const DEFAULT_SUPPLIER_QUERY: SupplierQuery = {
  search: "",
  sortKey: "name",
  desc: false,
  page: 0,
};

/**
 * The text a search term is matched against: everything printed on the row,
 * plus the email — which is how two entries for the same trading name are told
 * apart, and what an owner usually has in front of them when they go looking.
 *
 * Deliberately NOT the products a supplier carries: that is a per-supplier list
 * behind the Products count, and folding it in here would make one keystroke
 * read the whole catalogue. Nothing in here is a cost; this screen carries none.
 */
function supplierHaystack(row: SupplierRow): string {
  return [row.name, row.group, row.country, row.currency, row.email]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Whitespace-separated terms, ANDed, matched as substrings — the same rule the
 *  catalogue search follows, so one box never behaves unlike the other. */
export function matchesSupplierSearch(row: SupplierRow, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = supplierHaystack(row);
  return terms.every((t) => text.includes(t));
}

function sortValue(row: SupplierRow, key: SupplierSortKey): string | number | null {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "group":
      return row.group?.toLowerCase() ?? null;
    case "leadTyped":
      return row.leadTimeTypedDays;
    case "learned":
      return row.learnedLeadDays;
    case "moq":
      return row.moq;
    case "products":
      return row.assignedProductCount;
    case "onTime":
      return row.onTimePct;
  }
}

/**
 * Search, then sort. Nulls sort last whichever way the column points: "not set"
 * is not a small number, and floating the blanks to the top of a descending view
 * buries the rows that actually have something to say. The id breaks the
 * remaining ties, because two suppliers with the same name must not swap places
 * between one page and the next — that is how a paged list loses a row.
 */
export function selectSuppliers(rows: SupplierRow[], q: SupplierQuery): SupplierRow[] {
  const matched = q.search ? rows.filter((r) => matchesSupplierSearch(r, q.search)) : rows;
  return [...matched].sort((a, b) => {
    const av = sortValue(a, q.sortKey);
    const bv = sortValue(b, q.sortKey);
    if (av == null && bv == null) return a.id.localeCompare(b.id);
    if (av == null) return 1;
    if (bv == null) return -1;
    const c =
      typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    if (c === 0) return a.id.localeCompare(b.id);
    return q.desc ? -c : c;
  });
}

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Reads the screen's state off the URL, surviving whatever a hand-edited
 *  address bar contains rather than throwing at the reader. */
export function parseSupplierQuery(
  params: Record<string, string | string[] | undefined>,
): SupplierQuery {
  const sort = one(params.sort);
  const page = Number.parseInt(one(params.page), 10);
  return {
    search: one(params.q).trim().slice(0, 120),
    sortKey: (SUPPLIER_SORT_KEYS as readonly string[]).includes(sort)
      ? (sort as SupplierSortKey)
      : DEFAULT_SUPPLIER_QUERY.sortKey,
    desc: one(params.dir) === "desc",
    page: Number.isFinite(page) && page > 0 ? page : 0,
  };
}

export type SuppliersScreen = {
  /** One page of suppliers, in the order the sort asked for. */
  rows: SupplierRow[];
  /** Suppliers the shop has, whatever is in the search box — the card's count,
   *  and what decides whether the empty state belongs here at all. */
  total: number;
  /** Suppliers the text matched: what the pager counts against. */
  matched: number;
  page: number;
  pageCount: number;
  /** 1-based index of the first row on the page ("showing 26–28 of 28"). */
  from: number;
};

/** The suppliers screen: the whole list counted, one page of it sent. */
export async function getSuppliersScreen(
  tenantId: string,
  query: SupplierQuery,
): Promise<SuppliersScreen> {
  const all = await getSuppliers(tenantId);
  const matched = selectSuppliers(all, query);
  const pageCount = Math.max(1, Math.ceil(matched.length / SUPPLIERS_PAGE_SIZE));
  const page = Math.min(Math.max(0, query.page), pageCount - 1);
  const start = page * SUPPLIERS_PAGE_SIZE;
  return {
    rows: matched.slice(start, start + SUPPLIERS_PAGE_SIZE),
    total: all.length,
    matched: matched.length,
    page,
    pageCount,
    from: start + 1,
  };
}

export type UnassignedBrand = {
  vendor: string;
  productCount: number;
  suggestedSupplierId: string | null;
  suggestedSupplierName: string | null;
};

/**
 * Unassigned products grouped by Shopify vendor (brand), biggest brand first,
 * each with a suggested supplier — the input to the bulk-assign bar. Products
 * with no vendor can't be assigned by brand, so they're left out here.
 */
export async function getUnassignedByBrand(tenantId: string): Promise<UnassignedBrand[]> {
  const db = prismaForTenant(tenantId);
  const [unassigned, assigned, suppliers] = await Promise.all([
    db.product.groupBy({
      by: ["vendor"],
      where: { supplierId: null, ...BUYABLE_PRODUCT_WHERE, vendor: { not: null } },
      _count: { _all: true },
    }),
    db.product.groupBy({
      by: ["vendor", "supplierId"],
      where: { supplierId: { not: null }, vendor: { not: null } },
      _count: { _all: true },
    }),
    db.supplier.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const supplierLites: SupplierLite[] = suppliers;
  const countsByVendor = new Map<string, { supplierId: string; count: number }[]>();
  for (const a of assigned) {
    if (!a.vendor || !a.supplierId) continue;
    const list = countsByVendor.get(a.vendor) ?? [];
    list.push({ supplierId: a.supplierId, count: a._count._all });
    countsByVendor.set(a.vendor, list);
  }

  return unassigned
    .filter((u): u is typeof u & { vendor: string } => !!u.vendor)
    .map((u) => {
      const suggestedSupplierId = suggestSupplierForVendor(
        u.vendor,
        supplierLites,
        countsByVendor.get(u.vendor) ?? [],
      );
      return {
        vendor: u.vendor,
        productCount: u._count._all,
        suggestedSupplierId,
        suggestedSupplierName: suggestedSupplierId
          ? (supplierName.get(suggestedSupplierId) ?? null)
          : null,
      };
    })
    .sort((a, b) => b.productCount - a.productCount || a.vendor.localeCompare(b.vendor));
}

export type AssignableProduct = {
  id: string;
  sku: string;
  title: string;
  /** Who it currently belongs to, so picking it is a visible reassignment. */
  supplierName: string | null;
};

/**
 * Candidates for "what do I buy from this supplier?" at the moment the supplier
 * is being created — so there is no supplier id to sort by yet.
 *
 * Same ceiling and the same deliberate non-restriction as the post-creation
 * picker: a shop assigning suppliers is tidying its catalogue, and hiding
 * drafts or deactivated rows would leave items it could never fix.
 */
export async function getAssignableProducts(tenantId: string): Promise<AssignableProduct[]> {
  const db = prismaForTenant(tenantId);
  const rows = await db.product.findMany({
    take: PICKER_LIMIT,
    orderBy: [{ title: "asc" }],
    select: { id: true, sku: true, title: true, supplier: { select: { name: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    sku: p.sku,
    title: p.title,
    supplierName: p.supplier?.name ?? null,
  }));
}

export type SupplierOption = { id: string; name: string };

/** Active suppliers for the assign/form pickers. */
export async function getSupplierOptions(tenantId: string): Promise<SupplierOption[]> {
  const db = prismaForTenant(tenantId);
  return db.supplier.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export type DriftAlert = {
  supplierId: string;
  supplierName: string;
  typedDays: number | null;
  learnedDays: number | null;
  deltaDays: number | null;
  direction: "later" | "earlier" | null;
};

/**
 * Suppliers whose learned lead time has drifted from the typed value — the
 * attention items this surface owns and a Today tile / notification can reuse.
 */
export async function getLeadTimeDriftAlerts(tenantId: string): Promise<DriftAlert[]> {
  const rows = await getSuppliers(tenantId);
  return rows
    .filter((r) => r.drift.drifting)
    .map((r) => ({
      supplierId: r.id,
      supplierName: r.name,
      typedDays: r.leadTimeTypedDays,
      learnedDays: r.learnedLeadDays,
      deltaDays: r.drift.deltaDays,
      direction: r.drift.direction,
    }));
}

export type PickerProduct = {
  id: string;
  title: string;
  sku: string | null;
  vendor: string | null;
  /** The supplier this product sits with today — null when it has none. */
  supplierId: string | null;
  supplierName: string | null;
  /** Per-product lead-time override; null = fall back to the supplier's. */
  leadTimeDays: number | null;
};

export type SupplierProductPicker = {
  supplierId: string;
  supplierName: string;
  /** Products already with this supplier, then the rest. */
  products: PickerProduct[];
  /** True when the list was cut short — the UI says so rather than implying
   *  the shop only has this many products. */
  truncated: boolean;
};

/** Ceiling on the picker list. A shop with thousands of SKUs narrows with the
 *  search box rather than scrolling; sending everything would make the page. */
const PICKER_LIMIT = 300;

/**
 * The candidate list behind "which products do I buy from this supplier?".
 *
 * Deliberately NOT restricted to buyable products: a shop assigning a supplier
 * is tidying its catalogue, and hiding the drafts and deactivated rows would
 * leave items it could never fix. Ordered so the supplier's current products
 * come first — the question is usually "what else", not "what at all".
 */
export async function getSupplierProductPicker(
  tenantId: string,
  supplierId: string,
  search?: string,
): Promise<SupplierProductPicker | null> {
  const db = prismaForTenant(tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) return null;

  const term = search?.trim();
  const rows = await db.product.findMany({
    where: term
      ? {
          OR: [
            { title: { contains: term, mode: "insensitive" } },
            { sku: { contains: term, mode: "insensitive" } },
            { vendor: { contains: term, mode: "insensitive" } },
          ],
        }
      : {},
    select: {
      id: true,
      title: true,
      sku: true,
      vendor: true,
      supplierId: true,
      leadTimeDays: true,
      supplier: { select: { name: true } },
    },
    orderBy: [{ title: "asc" }],
    take: PICKER_LIMIT + 1,
  });

  const truncated = rows.length > PICKER_LIMIT;
  const products = rows.slice(0, PICKER_LIMIT).map(
    (p): PickerProduct => ({
      id: p.id,
      title: p.title,
      sku: p.sku,
      vendor: p.vendor,
      supplierId: p.supplierId,
      supplierName: p.supplier?.name ?? null,
      leadTimeDays: p.leadTimeDays,
    }),
  );
  products.sort((a, b) => {
    const mine = Number(b.supplierId === supplier.id) - Number(a.supplierId === supplier.id);
    return mine || a.title.localeCompare(b.title);
  });

  return { supplierId: supplier.id, supplierName: supplier.name, products, truncated };
}
