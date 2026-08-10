/**
 * One way to say "how much has this moved".
 *
 * The revenue tile and the chart under it both compare the last 30 days with
 * the 30 before. They agreed on the money after the window fix, and still
 * printed "-14.9%" beside "-15%" — the same number rounded to two different
 * precisions, a hand's width apart on the first screen of the morning. To a
 * shop owner that reads as the product disagreeing with itself again.
 *
 * Whole percent, because that is the granularity the figure deserves: nobody
 * reorders differently at -14.9 than at -15.
 */

/** Null when there is no prior period to compare against. */
export function deltaPercent(current: number, prior: number): number | null {
  if (prior <= 0) return null;
  return Math.round(((current - prior) / prior) * 100);
}
