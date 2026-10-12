/**
 * Weekly spot-check picker — which SKUs to physically count.
 *
 * Shelf-vs-system drift (theft, breakage, miscounts, un-scanned sales) is
 * invisible until someone counts. Counting the whole catalogue every week is a
 * non-starter, so each week we prompt the owner to count the handful of SKUs
 * where drift costs the most: the highest capital-at-risk MOVING items. A dead
 * or empty SKU is skipped — there is nothing to drift and nothing to lose.
 *
 * Pure and deterministic: the caller passes candidates, this ranks and slices.
 */

export type SpotCandidate = {
  id: string;
  /** Units/day — used to skip dead SKUs and to break value ties. */
  runRate: number;
  /** On-hand the system believes right now. Skip when ≤0 (nothing to count). */
  currentStock: number;
  /** Capital at risk on the shelf (stock × cost or price) — the thing we're
   *  protecting, so the biggest is counted first. */
  valueKes: number;
};

/** Default number of SKUs to prompt per week — small enough to actually do. */
export const SPOT_CHECK_COUNT = 5;

/**
 * The `count` highest-value MOVING SKUs to count this week. Skips dead/empty
 * SKUs (no run rate or no stock). Deterministic: value desc, then run rate desc,
 * then id — so the same catalogue always yields the same set for a given week.
 */
export function selectSpotChecks<T extends SpotCandidate>(
  products: T[],
  count: number = SPOT_CHECK_COUNT
): T[] {
  return products
    .filter((p) => p.runRate > 0 && p.currentStock > 0)
    .sort(
      (a, b) =>
        b.valueKes - a.valueKes || b.runRate - a.runRate || a.id.localeCompare(b.id)
    )
    .slice(0, count);
}
