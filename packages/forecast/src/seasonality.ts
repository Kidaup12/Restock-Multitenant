/**
 * Seasonality the shop states, not seasonality the calendar guesses.
 *
 * Calendar guesses — public holidays, payday spikes — were in this engine and
 * were taken out: backtesting showed they hurt accuracy without a full season of
 * history to learn from, and no workspace has one yet. This is the other kind of
 * knowledge. "December is about triple" is a fact the owner holds and the sales
 * history cannot yet contain, so the engine takes it the same way it takes a
 * declared promo: as a stated multiplier on the history-derived baseline, still
 * bounded by the runaway cap.
 *
 * A month with no stated multiplier changes nothing. That is the default, and it
 * is why this can ship before anyone has used it.
 */

/** How far the sizing horizon reaches. Matches the engine's 30-day forecast. */
export const SEASONAL_HORIZON_DAYS = 30;

/**
 * Bounds on a stated multiplier.
 *
 * Wide enough for a real December, narrow enough that a slipped decimal cannot
 * order a hundred times the shop's turnover. A shop that genuinely needs more
 * than 4x should declare a promo window, which carries its own dates.
 */
export const SEASONAL_MIN = 0.25;
export const SEASONAL_MAX = 4;

/** Month key as stored on MonthlyContext: `YYYY-MM`, tenant-local. */
export function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Clamp a stated multiplier, or null when there is nothing usable to state. */
export function boundedMultiplier(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(SEASONAL_MAX, Math.max(SEASONAL_MIN, value));
}

export type MonthlyExpectation = {
  /** `YYYY-MM`. */
  month: string;
  /** What the owner says that month runs at, 1 = normal. */
  multiplier: number;
};

/**
 * One multiplier for a horizon that almost never sits inside one month.
 *
 * A 30-day horizon from 20 December is 12 days of December and 18 of January,
 * and those two months can be told apart by the shop — a Christmas run followed
 * by the quietest month of the year. Weighting by the days the horizon actually
 * spends in each month is the difference between ordering for Christmas and
 * ordering for Christmas twice.
 *
 * Months with nothing stated count as normal (1), so a shop that has declared
 * only December still gets a sensible blend either side of it.
 */
export function blendedSeasonalMultiplier(
  expectations: MonthlyExpectation[],
  today: Date,
  horizonDays: number = SEASONAL_HORIZON_DAYS
): number {
  const days = Math.max(0, Math.floor(horizonDays));
  if (days === 0 || expectations.length === 0) return 1;

  const stated = new Map<string, number>();
  for (const e of expectations) {
    const bounded = boundedMultiplier(e.multiplier);
    if (bounded != null) stated.set(e.month, bounded);
  }
  if (stated.size === 0) return 1;

  // Walk the horizon a day at a time and average what each day is worth. Simpler
  // than month arithmetic and correct across year boundaries and month lengths
  // without a special case for either.
  let total = 0;
  for (let i = 0; i < days; i += 1) {
    const day = new Date(today.getTime() + i * 86_400_000);
    total += stated.get(monthKeyOf(day)) ?? 1;
  }
  const blended = total / days;

  // The blend of bounded values is itself bounded, but say so rather than rely
  // on it: this number multiplies a forecast.
  return Math.min(SEASONAL_MAX, Math.max(SEASONAL_MIN, blended));
}

/** Plain words for the explanation, or null when the month is normal. */
export function seasonalLabel(multiplier: number): string | null {
  if (Math.abs(multiplier - 1) < 0.005) return null;
  const pct = Math.round((multiplier - 1) * 100);
  return pct > 0 ? `Busier season you told us about, +${pct}%` : `Quieter season you told us about, ${pct}%`;
}
