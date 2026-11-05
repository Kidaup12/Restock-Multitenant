import { prismaForTenant } from "@wezesha/db";
import { shelfDaysSince } from "@wezesha/forecast";

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

/**
 * Days each product has been continuously on the shelf, capped at `windowDays`:
 * days since its last daily snapshot with onHand <= 0 inside the window. One
 * groupBy over the (few) empty rows. Products absent from the map had no empty
 * day in the window — full credit. Missing snapshot days are not counted as
 * empty.
 */
export async function shelfDaysByProduct(tenantId: string, windowDays: number, asOf = new Date()): Promise<Map<string, number>> {
  const db = prismaForTenant(tenantId);
  const since = new Date(asOf.getTime() - windowDays * 86_400_000);
  const rows = await db.inventorySnapshot.groupBy({
    by: ["productId"],
    where: { date: { gte: since, lt: asOf }, onHand: { lte: 0 } },
    _max: { date: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) if (r._max.date) out.set(r.productId, shelfDaysSince(r._max.date, windowDays, asOf));
  return out;
}
