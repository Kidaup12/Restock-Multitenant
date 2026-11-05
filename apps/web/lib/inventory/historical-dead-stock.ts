import { isDeadStock, shelfDaysSince } from "./dead-stock";

/** Historical eligibility uses the same age and time-on-shelf rules as Today. */
export function historicalDeadStock(input: {
  onHand: number;
  asOf: Date;
  windowDays: number;
  firstSeenAt: Date | null;
  firstSaleAt: Date | null;
  sales: readonly Date[];
  observations: readonly { date: Date; onHand: number }[];
}): boolean {
  const cutoff = new Date(+input.asOf - input.windowDays * 86400000);
  let lastSaleAt = input.firstSaleAt && input.firstSaleAt <= input.asOf ? input.firstSaleAt : null;
  for (const date of input.sales) {
    if (date <= input.asOf && (!lastSaleAt || date > lastSaleAt)) lastSaleAt = date;
  }
  const observed = input.observations.filter(s => s.date >= cutoff && s.date <= input.asOf);
  // Time on shelf as of that date: days since the last empty snapshot in the window.
  let lastEmpty: Date | null = null;
  for (const s of observed) if (s.onHand <= 0 && (!lastEmpty || s.date > lastEmpty)) lastEmpty = s.date;
  return isDeadStock({ currentStock: input.onHand, asOf: input.asOf, cutoff,
    firstSeenAt: input.firstSeenAt, lastSaleAt,
    shelfDays: lastEmpty ? shelfDaysSince(lastEmpty, input.windowDays, input.asOf) : undefined });
}

/** Unsold is an observation, not an age/grace verdict: no positive sale by that date. */
export function historicalUnsoldStock(onHand: number, firstSaleAt: Date | null, asOf: Date): boolean {
  return onHand > 0 && (firstSaleAt == null || firstSaleAt > asOf);
}
