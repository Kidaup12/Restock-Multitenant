/**
 * ABC-class minimum serving rate.
 *
 * A bestseller that has been out of stock for most of a window can have its
 * censored run rate decay toward zero — the shelf was empty, so few sales were
 * recorded, so the rate says "barely sells", so the buy list under-orders the
 * exact item that was starving. Censoring the denominator (see baseline.ts)
 * helps, but on a near-total stockout there are too few in-stock days left to
 * measure a rate from at all.
 *
 * The floor guarantees a Class-A (and, lower, Class-B) product a minimum daily
 * rate so it is served at a real speed instead of vanishing off the buy list.
 * Class C gets no floor — a slow mover reading as slow is correct.
 *
 * Crucially the floor only ever LIFTS a product that is genuinely a seller: it
 * requires proof of real recent demand (`hadRecentSales`). It must never raise
 * a dead listing's rate above zero — layeredForecast treats a zero history rate
 * as "dead, never recommend", and a floor that resurrected it would put dead
 * stock back on the buy list. So a product with no sales in the window is left
 * exactly at its computed rate.
 *
 * Pure: the caller passes the computed rate, the class, and whether the product
 * sold at all recently.
 */

import type { AbcCategory } from "./abc";

/**
 * Minimum daily units per ABC class. A ≈ one unit every ~2.5 days; B ≈ one unit
 * every ~10 days; C none. Tunable constants — deliberately conservative so the
 * floor rescues starved bestsellers without inventing demand for the long tail.
 */
export const ABC_RATE_FLOORS: Record<AbcCategory, number> = {
  A: 0.4,
  B: 0.1,
  C: 0,
};

/**
 * Lift a computed daily rate up to its ABC-class floor, but only for a product
 * with proven recent demand. Returns the rate unchanged when:
 *   - the class has no floor (C, or an unknown/unclassified class), or
 *   - the product had no recent sales (`hadRecentSales` false) — flooring here
 *     would resurrect a dead listing, and layeredForecast's dead-stock guard
 *     keys off a zero rate, or
 *   - the rate already meets or exceeds the floor.
 *
 * @param rate            the computed (censored) daily rate
 * @param abc             the product's ABC class
 * @param hadRecentSales  true if the product sold at least once in the rate window
 */
export function applyAbcRateFloor(
  rate: number,
  abc: AbcCategory | null | undefined,
  hadRecentSales: boolean
): number {
  if (!hadRecentSales) return rate;
  const floor = abc === "A" || abc === "B" ? ABC_RATE_FLOORS[abc] : 0;
  return rate > floor ? rate : floor;
}
