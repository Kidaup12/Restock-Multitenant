/**
 * ABC classification — single source of truth.
 *
 * Pareto on **sales value** (the industry standard — inventory tools rank ABC
 * by value, never units): sort products by sales value (desc) and cut by
 * cumulative share — top 70% = A, next 20% = B, tail 10% = C.
 *
 * Feed `revenue` DAILY sales value (run rate x price) rather than a cumulative
 * total, so a SKU that USED to sell but has gone slow drops out of A, while a
 * pricey earner still outranks a cheap fast-mover.
 */
import { weightedDailyRateAdjusted, type SalesPoint } from "./baseline";

export type AbcInput = { id: string; revenue: number };
export type AbcCategory = "A" | "B" | "C";

export function assignAbc(productsWithValue: AbcInput[]): Record<string, AbcCategory> {
  const sorted = [...productsWithValue].sort((a, b) => b.revenue - a.revenue);
  const total = sorted.reduce((s, p) => s + p.revenue, 0);
  let cumulative = 0;
  const map: Record<string, AbcCategory> = {};
  for (const p of sorted) {
    cumulative += p.revenue;
    const pct = total > 0 ? cumulative / total : 1;
    if (pct <= 0.7) map[p.id] = "A";
    else if (pct <= 0.9) map[p.id] = "B";
    else map[p.id] = "C";
  }
  return map;
}

/** The ABC ranking value for one product: gap-corrected recency-weighted daily
 *  units x unit price. Uses the stockout-adjusted rate so a strong earner that
 *  keeps selling out isn't ranked on its deflated on-shelf rate. Compute this
 *  for every product, then pass the lot to assignAbc. */
export function dailySalesValue(history: SalesPoint[], priceKes: number, asOf?: Date): number {
  return weightedDailyRateAdjusted(history, asOf) * priceKes;
}
