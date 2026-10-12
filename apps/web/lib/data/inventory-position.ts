import { BUYABLE_PRODUCT_WHERE, OUTSTANDING_PO_STATUSES, effectiveOnOrder, outstandingByProduct, prismaForTenant } from "@wezesha/db";
import { positionRow, selectPositionRows, type PositionWindow } from "@/lib/inventory/position";
import { trailingWindow } from "./trailing-window";

/** Shop-wide sellable position. No costs selected, so every member may export it. */
export async function getInventoryPosition(tenantId: string, windowDays: PositionWindow, search = "", asOf = new Date()) {
  const db = prismaForTenant(tenantId);
  const { start } = trailingWindow(windowDays, asOf);
  const startKey = start.toISOString().slice(0, 10);
  const endKey = asOf.toISOString().slice(0, 10);
  const [products, sales, snapshots, poLines] = await Promise.all([
    db.product.findMany({ where: { ...BUYABLE_PRODUCT_WHERE }, select: {
      id: true, title: true, sku: true, abcCategory: true, currentStock: true, onOrder: true,
      supplier: { select: { name: true } },
    } }),
    db.salesHistory.groupBy({ by: ["productId", "date"], where: { date: { gte: start, lte: asOf } }, _sum: { quantity: true } }),
    db.inventorySnapshot.findMany({ where: { date: { gte: start, lte: asOf } }, select: { productId: true, date: true, onHand: true } }),
    db.purchaseOrderLine.findMany({ where: { purchaseOrder: { status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null } },
      select: { productId: true, quantity: true, receivedQty: true } }),
  ]);
  const sold = new Map<string, { units: number; days: Set<string> }>();
  for (const sale of sales) {
    const value = sold.get(sale.productId) ?? { units: 0, days: new Set<string>() };
    const qty = sale._sum.quantity ?? 0;
    value.units += qty;
    if (qty > 0) value.days.add(sale.date.toISOString().slice(0, 10));
    sold.set(sale.productId, value);
  }
  const observations = new Map<string, Map<string, number>>();
  for (const snapshot of snapshots) {
    const days = observations.get(snapshot.productId) ?? new Map<string, number>();
    days.set(snapshot.date.toISOString().slice(0, 10), snapshot.onHand);
    observations.set(snapshot.productId, days);
  }
  const inbound = outstandingByProduct(poLines);
  const rows = products.map(p => {
    const history = sold.get(p.id);
    const observed = observations.get(p.id) ?? new Map<string, number>();
    const opening = observed.get(startKey);
    return positionRow({ productId: p.id, title: p.title, sku: p.sku, abc: p.abcCategory,
      supplier: p.supplier?.name ?? null, onHand: p.currentStock,
      inbound: effectiveOnOrder(p.onOrder, inbound.get(p.id) ?? 0), windowDays,
      soldUnits: history?.units ?? 0, saleDays: history?.days.size ?? 0,
      observedDays: observed.size, inStockDays: [...observed.values()].filter(n => n > 0).length,
      stockoutDays: [...observed.values()].filter(n => n <= 0).length,
      openingSnapshot: opening == null ? null : { onHand: opening, date: startKey },
    });
  });
  return { windowDays, startKey, endKey, rows: selectPositionRows(rows, search) };
}
