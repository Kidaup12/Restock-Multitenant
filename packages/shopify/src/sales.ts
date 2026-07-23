import { numericCore } from "./ids";
import type { ShopifyOrderNode } from "./resources";

/**
 * Pure order → (product, day) aggregation for the idempotent day-set sales
 * writer. Two rules earned by production bugs:
 *
 *  - Bucket by `processedAt ?? createdAt`. createdAt is API-insertion time;
 *    imported / back-dated / POS-channel orders carry the real sale date in
 *    processedAt, and bucketing by createdAt collapses months of history onto
 *    the sync day.
 *  - Look products up by NUMERIC CORE (line items carry gids; the catalog map
 *    is keyed by core), so id-spelling mismatches can't orphan sales.
 */

export type DayBucket = {
  productId: string; // local Product.id
  dateKey: string; // YYYY-MM-DD (UTC)
  quantity: number;
  revenue: number;
};

/** Aggregate order line items into (product, day) buckets. `productIdByCore`
 *  maps a Shopify product id CORE → local product id. */
export function bucketSalesByProductDay(
  orders: ShopifyOrderNode[],
  productIdByCore: Map<string, string>
): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  for (const order of orders) {
    const saleAt = order.processedAt ?? order.createdAt;
    if (!saleAt) continue;
    const dateKey = saleAt.slice(0, 10); // YYYY-MM-DD
    for (const line of order.lineItems ?? []) {
      const gid = line.product?.id;
      if (!gid) continue;
      const productId = productIdByCore.get(numericCore(gid));
      if (!productId) continue; // product not in the catalog — skip
      const qty = line.quantity ?? 0;
      if (qty <= 0) continue;
      const unit = line.originalUnitPriceSet?.shopMoney?.amount
        ? Number.parseFloat(line.originalUnitPriceSet.shopMoney.amount)
        : 0;
      const revenue = Number.isFinite(unit) ? unit * qty : 0;

      const key = `${productId}|${dateKey}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.quantity += qty;
        existing.revenue += revenue;
      } else {
        buckets.set(key, { productId, dateKey, quantity: qty, revenue });
      }
    }
  }
  return buckets;
}

/**
 * Day-aligned start of a sync window.
 *
 *  - First run (no cursor): look back `firstRunLookbackDays`.
 *  - Subsequent runs: stored cursor minus `overlapHours` of safety (late /
 *    edited records), floored to UTC midnight so whole days are re-pulled —
 *    required for the idempotent day-set sales writer.
 */
export function computeWindowStart(
  cursor: Date | null,
  now: Date,
  opts: { overlapHours: number; firstRunLookbackDays: number }
): Date {
  const base = cursor
    ? new Date(cursor.getTime() - opts.overlapHours * 3600_000)
    : new Date(now.getTime() - opts.firstRunLookbackDays * 24 * 3600_000);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
}
