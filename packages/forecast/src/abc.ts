/**
 * ABC classification — single source of truth.
 *
 * Pareto on **actual trailing revenue** (the industry standard — inventory tools
 * rank ABC by value, never units): sort products by what they really earned over
 * the shop's ABC window and cut by cumulative share — top 70% = A, next 20% = B,
 * tail 10% = C.
 *
 * `revenue` is money actually taken, NOT run rate x price tag. Ranking on the
 * price tag lets an expensive item that barely sells ride its price into A. The
 * question an owner is asking is which lines earn the most, and receipts answer
 * it; a price tag only says what one would earn if it sold.
 *
 * VELOCITY FLOOR: even on real revenue, a rarely-sold premium item can carry a
 * large number on a handful of sales. A product below MIN_RUN_RATE_FOR_A
 * units/day can never be A, and below MIN_RUN_RATE_FOR_B it is long-tail C.
 * Callers pass `runRate` — the same rate the catalogue shows, so the letter can
 * never contradict the sells/day printed beside it.
 *
 * The two floors are the same numbers as ABC_RATE_FLOORS in rate-floor.ts, and
 * deliberately so: that file GUARANTEES a class-A product 0.4/day of demand,
 * this one decides who qualifies for it. Qualification below the guarantee means
 * a slow line is ordered at four times what it sells. Change one, read the other.
 *
 * The floor only ever demotes, so a shop where a genuine bestseller has been out
 * of stock for most of the window can lose it from A. `runRate` is expected to be
 * stockout-censored, which covers all but a near-total stockout.
 */
import type { SalesPoint } from "./baseline";

/** Below this daily rate a product cannot be class A (0.4/day is about 12 sales
 *  a month). A bestseller has to actually move. */
export const MIN_RUN_RATE_FOR_A = 0.4;
/** Below this it isn't a steady mid-tier B either — it's the long tail. */
export const MIN_RUN_RATE_FOR_B = 0.1;

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
    // Velocity floor, applied after the value cut. Only when the caller supplied
    // a rate: without one the classification is unchanged.
    if (p.runRate != null) {
      if (cls === "A" && p.runRate < MIN_RUN_RATE_FOR_A) cls = "B";
      if (cls === "B" && p.runRate < MIN_RUN_RATE_FOR_B) cls = "C";
    }
    map[p.id] = cls;
  }
  return map;
}

/** The windows a shop can rank its classes over, in days. */
export const ABC_WINDOW_CHOICES = [30, 60, 90] as const;
export type AbcWindowDays = (typeof ABC_WINDOW_CHOICES)[number];
export const DEFAULT_ABC_WINDOW_DAYS: AbcWindowDays = 90;

/** A stored window constrained to the offered choices. Anything else — an unset
 *  column, a value that reached the row some other way — reads as the default,
 *  so the engine and the settings screen cannot disagree about what is valid. */
export function resolveAbcWindowDays(value: number | null | undefined): AbcWindowDays {
  return (ABC_WINDOW_CHOICES as readonly number[]).includes(value as number)
    ? (value as AbcWindowDays)
    : DEFAULT_ABC_WINDOW_DAYS;
}

const DAY_MS = 86_400_000;

/** What one product actually earned over the window. Rows carrying units but no
 *  money — a till line with no price signal, a Shopify line with no unit price
 *  or fully discounted — fall back to the catalogue price, so a shop whose feed
 *  omits prices still ranks its real sellers instead of filing them all under C.
 *  That fallback is confined to the rows with the gap; everything else is the
 *  receipt. */
export function trailingRevenue(
  history: SalesPoint[],
  priceKes: number,
  windowDays: number,
  asOf: Date
): number {
  const since = asOf.getTime() - windowDays * DAY_MS;
  let sum = 0;
  for (const p of history) {
    if (p.date.getTime() < since) continue;
    sum += p.revenueKes || p.quantity * priceKes;
  }
  return sum;
}
