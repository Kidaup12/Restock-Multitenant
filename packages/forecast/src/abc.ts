/**
 * ABC classification — single source of truth.
 *
 * Pareto on **revenue** (the industry standard — inventory tools rank ABC by
 * value, never units): sort products by revenue (desc) and cut by cumulative
 * share — top 70% = A, next 20% = B, tail 10% = C.
 *
 * Feed `revenue` ACTUAL TRAILING revenue (real money sold over the ABC window,
 * default 90 days) rather than an instantaneous rate×price, so classification
 * reflects what a SKU has genuinely earned — "expensive, not revenue" can't ride
 * a price tag into A on a handful of sales.
 *
 * VELOCITY FLOOR: even ranked by real revenue, a rarely-selling premium item can
 * carry high revenue on very few sales. A product below MIN_RUN_RATE_FOR_A
 * units/day can never be A (demoted to B, or to C below MIN_RUN_RATE_FOR_B), so
 * the A service level and buy-list priority stay reserved for genuine movers.
 * Pass each product's run rate to enable the floor; omit it to skip.
 */
import { weightedDailyRateAdjusted, type SalesPoint } from "./baseline";

/** A near-stockout premium SKU can carry high revenue on a handful of sales; the
 *  floor keeps it out of A so A means "a genuine mover". ~1 unit / 2.5 days. */
export const MIN_RUN_RATE_FOR_A = 0.4;
/** Below this (~1 unit / 10 days) an item is C — the tail's lean-cash sizing. */
export const MIN_RUN_RATE_FOR_B = 0.1;

/** Trailing window (days) over which ABC revenue is summed. */
export const ABC_WINDOW_DAYS = 90;

export type AbcInput = { id: string; revenue: number; runRate?: number };
export type AbcCategory = "A" | "B" | "C";

export function assignAbc(productsWithValue: AbcInput[]): Record<string, AbcCategory> {
  const sorted = [...productsWithValue].sort((a, b) => b.revenue - a.revenue);
  const total = sorted.reduce((s, p) => s + p.revenue, 0);
  let cumulative = 0;
  const map: Record<string, AbcCategory> = {};
  for (const p of sorted) {
    // Cut on the share ABOVE this product, not including it. Counting itself
    // first meant a shop whose best seller is most of its value scored that
    // product against its own share and filed the top earner under C — where
    // the tail's lean-cash min/max sizing then took over its ordering.
    const above = total > 0 ? cumulative / total : 1;
    cumulative += p.revenue;
    let cls: AbcCategory = above < 0.7 ? "A" : above < 0.9 ? "B" : "C";
    // Velocity floor: a slow mover can't ride revenue into A/B.
    if (p.runRate != null) {
      if (cls === "A" && p.runRate < MIN_RUN_RATE_FOR_A) cls = "B";
      if (cls === "B" && p.runRate < MIN_RUN_RATE_FOR_B) cls = "C";
    }
    map[p.id] = cls;
  }
  return map;
}

/** Actual revenue a product earned over the trailing window — the ABC ranking
 *  value. Sums SalesHistory.revenueKes in [asOf - windowDays, asOf). This is
 *  what a SKU really brought in, not a rate×price projection. */
export function trailingRevenue(
  history: SalesPoint[],
  asOf: Date = new Date(),
  windowDays: number = ABC_WINDOW_DAYS
): number {
  const since = new Date(asOf);
  since.setUTCDate(since.getUTCDate() - windowDays);
  let sum = 0;
  for (const p of history) {
    if (p.date >= since && p.date < asOf) sum += p.revenueKes ?? 0;
  }
  return sum;
}

/** Instantaneous sales value: gap-corrected recency-weighted daily units × unit
 *  price. Kept for callers that want a rate×price figure; ABC ranking now uses
 *  trailingRevenue instead. */
export function dailySalesValue(history: SalesPoint[], priceKes: number, asOf?: Date): number {
  return weightedDailyRateAdjusted(history, asOf) * priceKes;
}
