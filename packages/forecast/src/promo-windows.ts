/**
 * Promo-spike exclusion for the run rate: one Black Friday must not inflate
 * every future recommendation. A past promo lifts sales for its window;
 * leaving those days in the baseline run rate permanently over-orders. So
 * history days that fall inside a matching promo window are dropped before
 * averaging. Callers gate whether to apply the exclusion.
 */

export type PromoWindow = { start: Date; end: Date; scope: string; scopeValue: string | null };
export type ProductMatch = { sku: string; productType: string | null; vendor: string | null };

/** Same scope-matching as the active-promo lift in the layered forecast. */
export function promoMatchesProduct(p: { scope: string; scopeValue: string | null }, prod: ProductMatch): boolean {
  return (
    p.scope === "all" ||
    (p.scope === "sku" && p.scopeValue === prod.sku) ||
    (p.scope === "category" && !!p.scopeValue && p.scopeValue.toUpperCase() === (prod.productType ?? "").toUpperCase()) ||
    (p.scope === "brand" && !!p.scopeValue && p.scopeValue.toUpperCase() === (prod.vendor ?? "").toUpperCase())
  );
}

/** The promo windows that apply to one product. */
export function windowsForProduct(promos: PromoWindow[], prod: ProductMatch): Array<{ start: Date; end: Date }> {
  return promos.filter((p) => promoMatchesProduct(p, prod)).map((p) => ({ start: p.start, end: p.end }));
}

/** Drop history points whose date falls inside any window (inclusive). */
export function excludePromoDays<T extends { date: Date }>(
  history: T[],
  windows: Array<{ start: Date; end: Date }>
): T[] {
  if (windows.length === 0) return history;
  return history.filter((h) => !windows.some((w) => h.date >= w.start && h.date <= w.end));
}

const DAY_MS = 86_400_000;
/** No single promo window expands past this many days — a mis-entered range
 *  (e.g. a decade) can't balloon the excluded-day set. */
const MAX_WINDOW_DAYS = 366;

function dayKeyMs(d: Date): number {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime();
}

/** Expand promo windows to the distinct UTC-midnight day-keys they cover, for
 *  censoring promo-spike days from the run rate. Bounds are inclusive; optional
 *  [since, until] (also inclusive) clamps the expansion to the history window so
 *  days outside it aren't generated. Each window is capped at MAX_WINDOW_DAYS. */
export function expandPromoWindowsToDays(
  windows: Array<{ start: Date; end: Date }>,
  since?: Date,
  until?: Date
): Date[] {
  const lo = since ? dayKeyMs(since) : -Infinity;
  const hi = until ? dayKeyMs(until) : Infinity;
  const seen = new Set<number>();
  const out: Date[] = [];
  for (const w of windows) {
    const end = dayKeyMs(w.end);
    let d = dayKeyMs(w.start);
    for (let i = 0; d <= end && i < MAX_WINDOW_DAYS; d += DAY_MS, i++) {
      if (d < lo || d > hi || seen.has(d)) continue;
      seen.add(d);
      out.push(new Date(d));
    }
  }
  return out;
}
