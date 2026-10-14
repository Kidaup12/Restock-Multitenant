/**
 * How many days of selling a what-if order has to cover, counted from today.
 *
 * The cover target is how long stock should last AFTER the delivery lands, so
 * the supplier's lead time goes on top of it. This used to be
 * `max(cover, lead)`, and the order tops up on-hand + on-order stock to that
 * horizon — so a 30-day supplier asked for 21 days of cover bought only enough
 * to reach the delivery, which then arrived to an empty shelf with no cover
 * behind it. That was smaller than the plain nightly plan (lead + a week).
 *
 * The lead is the MEASURED one (product override, else the supplier's average).
 * An unknown lead adds nothing: sizing never rests on a guess, the same rule the
 * nightly run follows.
 */
export function whatIfSizeDays(coverDays: number, measuredLeadDays: number | null): number {
  return coverDays + Math.max(0, measuredLeadDays ?? 0);
}

/**
 * Most-pressing-first for a budget: whose LAST SAFE ORDER DAY is soonest.
 *
 * Days until stockout alone ranks a 20-day item behind a 6-day one, even when
 * the 20-day item comes from a 60-day supplier and is already 40 days late to
 * order while the 6-day one arrives in two. Days left to order is stockout
 * minus lead time, so the supplier's wait decides who is funded first.
 *
 * Everything already due today ties at zero, so among lines that all need
 * ordering now, urgency and revenue at risk decide (the caller's next keys),
 * not merely which one is most overdue.
 */
export function byOrderDeadline(
  a: { daysLeftToOrder: number },
  b: { daysLeftToOrder: number }
): number {
  return Math.max(0, a.daysLeftToOrder) - Math.max(0, b.daysLeftToOrder);
}
