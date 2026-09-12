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
 * **It only speaks when the shelf was actually empty.** The floor compensates
 * for a measurement the stockout ruined; where there was no stockout there is
 * nothing to compensate for, and lifting the rate then invents demand the shelf
 * has never seen. Until 2026-09-10 the only gate was "sold at least one unit in
 * the last 30 days", so a product that sat fully stocked all year and genuinely
 * sells 0.09/day was served at 0.4/day — four times its real demand, ordered
 * against a lead time. A shop reported it as "Run/day looks wrong"; three
 * fully-stocked lines in one reproduction were each lifted to exactly 0.4.
 *
 * "Most of a window" is the trigger this file already described, so that is what
 * it now requires: the shelf empty on a majority of the days we have snapshot
 * proof for. No proof at all means no floor — a tenant without snapshots is
 * already served by the rate's own gap inference (baseline.ts), which is the
 * mechanism for exactly that case.
 *
 * Pure: the caller passes the computed rate, the class, whether the product sold
 * at all recently, and whether the shelf was mostly empty while it was measured.
 */

import type { AbcCategory } from "./abc";
import { dayKeyOf } from "./baseline";

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
 * Was the shelf empty for most of the days we can prove anything about?
 *
 * Proof comes from the nightly inventory snapshot. `snapshotsSince` bounds how
 * far back it reaches, so a tenant three days into snapshotting is judged on
 * three days rather than credited with a month it has no record of. Days before
 * that, and tenants with no snapshots at all, are not proof of a full shelf —
 * they are the absence of evidence, and the floor stays quiet for them.
 *
 * @param stockoutDates  days the snapshot recorded zero on hand
 * @param snapshotsSince first day the tenant has snapshots for
 * @param windowStart    start of the rate window being judged (inclusive)
 * @param today          end of that window (exclusive — today is still trading)
 */
export function shelfWasMostlyEmpty(
  stockoutDates: Date[] | undefined,
  snapshotsSince: Date | undefined,
  windowStart: Date,
  today: Date
): boolean {
  if (!snapshotsSince) return false;

  const from = Math.max(dayKeyOf(windowStart), dayKeyOf(snapshotsSince));
  const to = dayKeyOf(today);
  const DAY_MS = 86_400_000;
  const provenDays = Math.round((to - from) / DAY_MS);
  if (provenDays <= 0) return false;

  const empty = new Set<number>();
  for (const d of stockoutDates ?? []) {
    const key = dayKeyOf(d);
    if (key >= from && key < to) empty.add(key);
  }
  // Strict majority: "most of a window", the trigger this floor was written for.
  return empty.size * 2 > provenDays;
}

/**
 * Lift a computed daily rate up to its ABC-class floor, but only for a product
 * with proven recent demand whose shelf was proven mostly empty. Returns the
 * rate unchanged when:
 *   - the class has no floor (C, or an unknown/unclassified class), or
 *   - the product had no recent sales (`hadRecentSales` false) — flooring here
 *     would resurrect a dead listing, and layeredForecast's dead-stock guard
 *     keys off a zero rate, or
 *   - the shelf was NOT mostly empty — the rate is then a measurement of demand
 *     rather than of an outage, and it stands, or
 *   - the rate already meets or exceeds the floor.
 *
 * @param rate            the computed (censored) daily rate
 * @param abc             the product's ABC class
 * @param hadRecentSales  true if the product sold at least once in the rate window
 * @param shelfMostlyEmpty true if the shelf was proven empty for most of that window
 */
export function applyAbcRateFloor(
  rate: number,
  abc: AbcCategory | null | undefined,
  hadRecentSales: boolean,
  shelfMostlyEmpty: boolean,
  /** Ceiling: the fastest this product has actually been seen to sell. Required
   *  rather than optional — omitting it silently restores the over-ordering the
   *  ceiling exists to stop. Null only when nothing has ever sold, in which case
   *  `hadRecentSales` is false and no floor applies anyway. */
  demonstratedRate: number | null
): number {
  const floor = abcFloorFor(abc, hadRecentSales, shelfMostlyEmpty);
  if (floor <= rate) return rate;
  // The floor lifts a starved bestseller back to a real serving speed. It must
  // not invent one: a line that sold four units in ninety days was served at
  // 0.4/day — twelve a month — because the constant never asked whether this
  // product had ever been fast. Lift toward the floor, never past what the shelf
  // has shown, and never below the computed rate.
  const ceiling = demonstratedRate == null ? floor : demonstratedRate;
  return Math.max(rate, Math.min(floor, ceiling));
}

/**
 * The fastest this product has actually been seen to sell: units over the span
 * from its first sale to its last.
 *
 * The span ENDS at the last sale, so the silence after a stockout does not drag
 * it down — a line that sold well and then ran out keeps a high figure and the
 * floor still rescues it. Measured over the history the run loads (one year),
 * so for anything listed inside that window it is the product's whole life.
 *
 * Two other definitions were measured against production and rejected. A raw
 * 30-day window counts empty-shelf days as no-demand days, which is exactly what
 * the rate calculation censors — it flagged a third of class C, a class with no
 * floor at all. Proven in-stock days is the right answer eventually, but
 * snapshot history is far shorter than the rate window, so it cannot yet
 * describe a 90-day history.
 */
export function demonstratedDailyRate(
  history: ReadonlyArray<{ date: Date; quantity: number }>
): number | null {
  let units = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const point of history) {
    if (point.quantity <= 0) continue;
    units += point.quantity;
    const at = point.date.getTime();
    if (at < first) first = at;
    if (at > last) last = at;
  }
  if (units <= 0) return null;
  const spanDays = Math.max(1, Math.round((last - first) / 86_400_000));
  return units / spanDays;
}

/**
 * The floor that applies to this product right now — 0 when none does.
 *
 * Separate from applying it because the buy list has to say out loud when the
 * number it shows is a floor rather than a measurement, and it can only know
 * that by comparing the two. Derived here rather than re-derived at the call
 * site so the two answers cannot drift: `applyAbcRateFloor` is written in terms
 * of this one.
 */
export function abcFloorFor(
  abc: AbcCategory | null | undefined,
  hadRecentSales: boolean,
  shelfMostlyEmpty: boolean
): number {
  if (!hadRecentSales) return 0;
  if (!shelfMostlyEmpty) return 0;
  return abc === "A" || abc === "B" ? ABC_RATE_FLOORS[abc] : 0;
}
