/**
 * Dead stock — one definition for the web app, the owner report and the
 * recommendations job.
 *
 * Dead means: held, no sale in the shop's window (N days), AND on the shelf for
 * those same N days. Time on shelf is days since the item was last seen out of
 * stock (daily snapshot onHand <= 0); restocking resets the clock. A product
 * that was empty for part of the window sold nothing because it couldn't, not
 * because nobody wanted it. (Upstream #100, replacing the fixed 14-day
 * observed-in-stock floor.)
 *
 * A product that has never sold is only dead once it is clearly not new.
 */

import { NEW_PRODUCT_DAYS } from "./layered";

const DAY_MS = 86_400_000;

export type DeadStockInput = {
  currentStock: number;
  lastSaleAt: Date | null;
  /** Earliest date the product is known to exist; null when unknown. */
  firstSeenAt?: Date | null;
  /** Days continuously on the shelf, capped at the window. Null/undefined = no
   *  out-of-stock evidence in the window → full credit. */
  shelfDays?: number | null;
  cutoff: Date;
  asOf: Date;
};

export function isDeadStock(input: DeadStockInput): boolean {
  if (input.currentStock <= 0 || (input.lastSaleAt && input.lastSaleAt >= input.cutoff)) return false;
  const windowDays = Math.round((input.asOf.getTime() - input.cutoff.getTime()) / DAY_MS);
  if (input.shelfDays != null && input.shelfDays < windowDays) return false;
  if (input.lastSaleAt) return true;
  return (
    input.firstSeenAt != null &&
    input.asOf.getTime() - input.firstSeenAt.getTime() >= NEW_PRODUCT_DAYS * DAY_MS
  );
}

/**
 * Days on the shelf given the last day the item was seen empty: in stock from
 * the day after through today, capped at the window. Null last-empty = full
 * credit (the window itself).
 */
export function shelfDaysSince(lastEmptyDay: Date | null, windowDays: number, asOf: Date): number {
  if (!lastEmptyDay) return windowDays;
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const empty = Date.UTC(lastEmptyDay.getUTCFullYear(), lastEmptyDay.getUTCMonth(), lastEmptyDay.getUTCDate());
  return Math.min(windowDays, Math.max(0, Math.round((today - empty) / DAY_MS)));
}
