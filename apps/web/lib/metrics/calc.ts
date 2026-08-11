import {
  runRateDaily,
  daysOfStockRemaining,
  NO_STOCKOUT_DAYS,
  type SalesPoint,
} from "@wezesha/forecast";

/**
 * The SHARED METRIC CONTRACT — the metric set defined once and computed the same
 * way everywhere (spec "Metrics & metadata"). Every function here is pure: the
 * math lives in @wezesha/forecast and this module is the single, named home the
 * data getters call so a metric never gets re-derived per screen.
 *
 * The one-engine rules this enforces:
 *   - Sellable on-hand has ONE source: Product.currentStock (the Sells-only
 *     rollup the sync maintains — warehouse/en-route stock is not sellable).
 *     These functions take that number; callers must not sum InventoryLevel a
 *     second, divergent way.
 *   - Run rate has ONE definition: the forecast engine's recency-weighted,
 *     stockout-corrected, all-channel rate (runRateDaily). Not a naive
 *     units/days, not the stale Product.dailySalesRate cache.
 *   - Cover has ONE formula: days of sellable stock left at the run rate,
 *     recomputed LIVE from current stock (so it tracks stock drift after a run).
 */

export type { AbcCategory, SalesPoint } from "@wezesha/forecast";

/** Revenue-per-product lookback windows (days), all channels. */
export const METRIC_WINDOWS = [30, 90, 365] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

/**
 * Run rate — blended, all-channel units/day (D3: one denominator). The engine's
 * recency-weighted, spike-damped rate over IN-STOCK days: pass the product's
 * proven out-of-stock day-keys from the nightly inventory snapshot plus
 * `snapshotsSince` (how far back that proof reaches), and days the shelf was
 * empty leave the denominator. Without them the engine infers stockouts from
 * sale gaps, which only catches runs longer than a week. Per-location run rate
 * is derived by allocation at the call site and MUST always be labelled — this
 * blended number is the headline.
 */
export function runRate(
  history: SalesPoint[],
  asOf: Date = new Date(),
  stockoutDates?: Date[],
  snapshotsSince?: Date
): number {
  return runRateDaily(history, asOf, stockoutDates, undefined, snapshotsSince);
}

/**
 * Cover (days left) — the ONE formula: sellable stock ÷ run rate, floored.
 * Recomputed live from current stock, so it reflects today's shelf even when
 * the last forecast run is stale.
 *
 * Clamped to the engine's 999 "effectively forever" sentinel. The engine only
 * returns that sentinel below 0.0001/day — about one unit every 27 years — so a
 * product that genuinely sells, but rarely, came through as a real number: a
 * live workspace showed **72999d** of cover, and 109499d beside it. Both are
 * arithmetically right and useless to a shop owner, and they read as a glitch
 * rather than as "you will never run out of this".
 *
 * Anything at or past the sentinel means the same thing, so it says the same
 * thing, and every screen's existing handling of 999 applies.
 */
export function coverDays(sellableOnHand: number, dailyRunRate: number): number {
  return Math.min(daysOfStockRemaining(sellableOnHand, dailyRunRate), NO_STOCKOUT_DAYS);
}

/** Revenue (KES) over a trailing window, all channels. */
export function revenueForWindow(
  history: SalesPoint[],
  windowDays: MetricWindow | number,
  asOf: Date = new Date()
): number {
  const since = asOf.getTime() - windowDays * 86_400_000;
  let sum = 0;
  for (const p of history) {
    if (p.date.getTime() >= since) sum += p.revenueKes ?? 0;
  }
  return sum;
}

/** Revenue over every contract window at once. */
export function revenueByWindow(
  history: SalesPoint[],
  asOf: Date = new Date()
): Record<MetricWindow, number> {
  return {
    30: revenueForWindow(history, 30, asOf),
    90: revenueForWindow(history, 90, asOf),
    365: revenueForWindow(history, 365, asOf),
  };
}

/**
 * Money at rest — unit cost × sellable on-hand (capital tied up in the shelf).
 * The dead-stock / capital-tied-up lens uses the same sellable source as cover,
 * so the two figures never disagree about how much stock a SKU has. Oversold
 * (negative) positions clamp to zero — you can't have negative capital at rest.
 */
export function moneyAtRest(costKes: number, sellableOnHand: number): number {
  return costKes * Math.max(0, sellableOnHand);
}


/**
 * There is deliberately NO ABC function here any more.
 *
 * The catalogue used to classify live, alongside the nightly run doing the same
 * work over its own clock. The same product could then be an A on Plan and a B
 * on Stock on the same morning, and the letter the screens showed was not the
 * one that had driven the order — the run's class is what the buy list ranks on
 * and what the per-class service levels are applied from.
 *
 * One producer: `packages/forecast-run` classifies and writes
 * `Product.abcCategory`; every screen reads that column (see catalogue.ts). A
 * product the run has not ranked reads null and shows "—", which is the honest
 * answer rather than a second opinion computed on the spot.
 */
