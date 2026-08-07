/**
 * One definition of "the last N days", for every screen that says it.
 *
 * The Today screen used to compute this twice: the revenue tile subtracted 30
 * days from the current instant and compared it against the date column, while
 * the chart beneath it truncated the same instant to a `YYYY-MM-DD` string and
 * compared that. The truncation made the boundary day inclusive for one and
 * exclusive for the other, so the chart covered 31 days and the tile 30 — one
 * day's revenue landing in the chart's numerator and the tile's denominator.
 * The result was two "last 30 days" figures a few percent apart, side by side
 * on the first screen a shop sees each morning.
 *
 * `SalesHistory.date` values are UTC midnights, so the window boundaries are
 * too: a boundary carrying a time-of-day silently drops or keeps its own day
 * depending on the hour the page was loaded.
 */

const DAY_MS = 86_400_000;

export type TrailingWindow = {
  /** UTC midnight of the first day IN the window. */
  start: Date;
  /** UTC midnight of the first day of the window before it. */
  priorStart: Date;
  /** Day key (YYYY-MM-DD) of `start`, for comparing against grouped day keys. */
  startKey: string;
  /** Days the window covers — what a per-day average must divide by. */
  days: number;
};

/**
 * The `days` calendar days ending today (today included), plus the equally long
 * window immediately before it.
 *
 * @param now Injectable for tests; defaults to the wall clock.
 */
export function trailingWindow(days: number, now: Date = new Date()): TrailingWindow {
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // days - 1 because today is inside the window: "last 30 days" ending today is
  // today plus the 29 before it, not today plus 30.
  const start = new Date(todayMidnight - (days - 1) * DAY_MS);
  return {
    start,
    priorStart: new Date(+start - days * DAY_MS),
    startKey: start.toISOString().slice(0, 10),
    days,
  };
}
