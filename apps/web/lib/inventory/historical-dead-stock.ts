import { isDeadStock } from "./dead-stock";

/** Historical eligibility uses the same age and observed-stock rules as Today. */
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
  const stockedDays = new Set(observed.filter(s => s.onHand > 0).map(s => s.date.toISOString().slice(0, 10)));
  return isDeadStock({ currentStock: input.onHand, asOf: input.asOf, cutoff,
    firstSeenAt: input.firstSeenAt, lastSaleAt,
    inStockDays: observed.length ? stockedDays.size : undefined });
}

/** Unsold is an observation, not an age/grace verdict: no positive sale by that date. */
export function historicalUnsoldStock(onHand: number, firstSaleAt: Date | null, asOf: Date): boolean {
  return onHand > 0 && (firstSaleAt == null || firstSaleAt > asOf);
}
