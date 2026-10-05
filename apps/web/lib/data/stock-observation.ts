import { prismaForTenant } from "@wezesha/db";

/** Missing coverage is unknown; observed zero days in stock is evidence. */
export async function observedInStockDays(tenantId: string, since: Date, asOf = new Date()): Promise<Map<string, number>> {
  const db = prismaForTenant(tenantId);
  const date = { gte: since, lt: asOf };
  // Aggregate in the database instead of loading months of daily snapshots.
  const [observed, stocked] = await Promise.all([
    db.inventorySnapshot.groupBy({ by: ["productId"], where: { date } }),
    db.inventorySnapshot.groupBy({ by: ["productId"], where: { date, onHand: { gt: 0 } }, _count: { _all: true } }),
  ]);
  const days = new Map<string, number>(observed.map(row => [row.productId, 0]));
  for (const row of stocked) days.set(row.productId, row._count._all);
  return days;
}
