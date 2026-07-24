import {
  runRateDaily,
  daysOfStockRemaining,
  assignAbc,
  dailySalesValue,
  NEW_PRODUCT_DAYS,
  type SalesPoint,
  type AbcCategory,
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
 * recency-weighted rate with stockout-gap correction; pass proven out-of-stock
 * day-keys to censor them, otherwise gaps are inferred (matches the forecast
 * run, which runs without a mask). Per-location run rate is derived by
 * allocation at the call site and MUST always be labelled — this blended number
 * is the headline.
 */
export function runRate(
  history: SalesPoint[],
  asOf: Date = new Date(),
  stockoutDates?: Date[]
): number {
  return runRateDaily(history, asOf, stockoutDates);
}

/**
 * Cover (days left) — the ONE formula: sellable stock ÷ run rate, floored.
 * Recomputed live from current stock, so it reflects today's shelf even when
 * the last forecast run is stale. A ~zero run rate returns the engine's 999
 * "effectively forever" sentinel.
 */
export function coverDays(sellableOnHand: number, dailyRunRate: number): number {
  return daysOfStockRemaining(sellableOnHand, dailyRunRate);
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

/** A product is "too new" to classify when Shopify created it inside the
 *  new-product window — it shows "—" rather than a misleading class. */
function isTooNew(createdAt: Date | null | undefined, asOf: Date): boolean {
  if (!createdAt) return false; // unknown age → treat as established
  return asOf.getTime() - createdAt.getTime() < NEW_PRODUCT_DAYS * 86_400_000;
}

export type AbcItem = {
  id: string;
  history: SalesPoint[];
  priceKes: number;
  /** Shopify creation date — drives the "—" too-new label. */
  createdAt?: Date | null;
};

/**
 * ABC class for the whole catalogue in one pass — the SAME assignAbc/
 * dailySalesValue primitives the nightly forecast run uses, so a product's
 * displayed class matches the class that drove its ordering strategy. Products
 * with no sales value, or too new to rank, come back null ("—"); excluding them
 * from the Pareto cut does not change any ranked product's class (they only
 * ever sit in the zero-value tail).
 */
export function abcForCatalogue(
  items: AbcItem[],
  asOf: Date = new Date()
): Map<string, AbcCategory | null> {
  const rankable = items
    .filter((it) => !isTooNew(it.createdAt, asOf))
    .map((it) => ({ id: it.id, revenue: dailySalesValue(it.history, it.priceKes, asOf) }))
    .filter((it) => it.revenue > 0);
  const classes = assignAbc(rankable);
  const out = new Map<string, AbcCategory | null>();
  for (const it of items) out.set(it.id, classes[it.id] ?? null);
  return out;
}
