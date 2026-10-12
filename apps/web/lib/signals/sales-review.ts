import { debulkSeries, detectSpikes, expandPromoWindowsToDays, promoMatchesProduct } from "@wezesha/forecast";

export type SalesReviewDay = {
  dayKey: string; quantity: number; baseline: number; multiple: number;
  kind: "possible_bulk" | "unusual_day"; threshold: number;
};

/** Daily totals are evidence of unusual demand, never proof of a single buyer.
 * Aggregate channels/branches before applying either detector and only match
 * promotions that actually apply to this product.
 */
export function salesReviewDays(input: {
  history: { date: Date; quantity: number }[];
  promos: { startDate: Date; endDate: Date; scope: string; scopeValue: string | null }[];
  product: { sku: string; vendor: string | null; productType: string | null };
  asOf: Date;
  bulkLookbackDays?: number;
}): SalesReviewDay[] {
  const byDay = new Map<string, number>();
  for (const point of input.history) {
    if (point.date > input.asOf) continue;
    const key = point.date.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + point.quantity);
  }
  const daily = [...byDay].map(([key, quantity]) => ({ date: new Date(`${key}T00:00:00Z`), quantity }));
  const promos = input.promos.filter(p => promoMatchesProduct(p, input.product)).map(p => ({ start: p.startDate, end: p.endDate }));
  const excludedDates = expandPromoWindowsToDays(promos, daily.length ? new Date(Math.min(...daily.map(p => +p.date))) : input.asOf, input.asOf);
  const explained = new Set(excludedDates.map(d => d.toISOString().slice(0, 10)));
  const clean = daily.filter(p => !explained.has(p.date.toISOString().slice(0, 10)));
  const out = new Map<string, SalesReviewDay>();
  for (const spike of detectSpikes(clean, [], input.asOf)) {
    const dayKey = spike.date.toISOString().slice(0, 10);
    out.set(dayKey, { dayKey, quantity: spike.quantity, baseline: spike.baseline,
      multiple: spike.multiple, kind: "unusual_day", threshold: Math.max(8, 3 * spike.baseline) });
  }
  const since = new Date(input.asOf.toISOString().slice(0, 10)).getTime() - (input.bulkLookbackDays ?? 365) * 86_400_000;
  // The UI can flag a large current-day total immediately. Forecast callers
  // separately use completed-day-only history for rate fitting.
  for (const cap of debulkSeries(clean).caps) {
    if (+cap.date < since) continue;
    const dayKey = cap.date.toISOString().slice(0, 10);
    out.set(dayKey, { dayKey, quantity: cap.original, baseline: cap.baseline,
      multiple: cap.multiple, kind: "possible_bulk", threshold: cap.threshold });
  }
  return [...out.values()].sort((a, b) => b.dayKey.localeCompare(a.dayKey) || b.multiple - a.multiple);
}
