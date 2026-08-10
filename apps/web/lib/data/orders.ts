import { prismaForTenant } from "@wezesha/db";
import { buildPoDocument, type PoDocumentData } from "@/lib/po/po-model";
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
};

export async function getPurchaseOrders(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<PoListRow[]> {
  const db = prismaForTenant(tenantId);
  const pos = await db.purchaseOrder.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
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
    },
  });
  return pos.map((po) => ({
    id: po.id,
    poNumber: po.poNumber,
    status: po.status,
    supplierName: po.supplier?.name ?? null,
    lineCount: po.lines.length,
    totalUnits: po.lines.reduce((s, l) => s + l.quantity, 0),
    receivedUnits: po.lines.reduce((s, l) => s + l.receivedQty, 0),
    subtotalKes: canViewCosts ? po.subtotalKes : null,
    createdAt: po.createdAt,
    sentAt: po.sentAt,
    expectedAt: po.expectedAt,
    receivedAt: po.receivedAt,
  }));
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
  createdByName: string | null;
  /** Who emailed it to the supplier. Read from the ledger rather than a column
   *  on the order: sending is recorded there already, and a denormalised copy
   *  would be a second place for the same fact to drift. Null for an order sent
   *  before the send started naming its actor. */
  sentByName: string | null;
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
  return {
    ...po,
    sentByName: sentEvent?.actorName ?? null,
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
