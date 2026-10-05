/** Original app's optional bulk-day cleaner. Daily totals indicate a possible
 * bulk purchase, not proof of one buyer/order. Receipt-level confirmation must
 * come from transaction data; this module only receives daily sales history.
 * Stored sales and revenue are never changed: the returned copy is for demand
 * calculations only. Existing general spike damping remains a separate rule.
 */
import { dayKeyOf, median, type SalesPoint } from "./baseline";

export const BULK_MULT = 5;
export const BULK_ABS_FLOOR = 6;
export const BULK_CAP_MULT = 3;

export type BulkCap = {
  date: Date;
  original: number;
  capped: number;
  baseline: number;
  threshold: number;
  multiple: number;
  evidence: "daily_total";
};

export type DebulkOptions = {
  /** Only completed trading days before this UTC day-key enter detection. */
  asOf?: Date;
  /** Known promos/closures are explained elsewhere and do not set the median. */
  excludedDates?: Date[];
};

export type DebulkResult<T extends SalesPoint = SalesPoint> = {
  /** Same row order and metadata; capped units distributed across a day's rows.
   * Revenue is preserved as historical fact, not recomputed as synthetic sales. */
  series: T[];
  caps: BulkCap[];
};

/** Flag days strictly above max(6, 5 × median positive day), then cap to
 * max(5, round(3 × median)). These are the original's executable thresholds
 * (its prose incorrectly described a cap floor of 6). Aggregate all channels
 * before classification, so neither branch splits nor duplicate date rows
 * create false separate sale days. Identical rows are summed, not deduplicated:
 * without receipt IDs the engine cannot tell duplicate imports from real sales.
 */
export function debulkSeries<T extends SalesPoint>(history: T[], opts: DebulkOptions = {}): DebulkResult<T> {
  const excluded = new Set((opts.excludedDates ?? []).map(dayKeyOf));
  const end = opts.asOf ? dayKeyOf(opts.asOf) : Infinity;
  const days = new Map<number, { total: number; positive: number; negative: number }>();
  for (const point of history) {
    const key = dayKeyOf(point.date);
    if (!Number.isFinite(key) || !Number.isFinite(point.quantity) || key >= end || excluded.has(key)) continue;
    const day = days.get(key) ?? { total: 0, positive: 0, negative: 0 };
    day.total += point.quantity;
    if (point.quantity > 0) day.positive += point.quantity;
    else day.negative += point.quantity;
    days.set(key, day);
  }
  const baseline = median([...days.values()].map((d) => d.total).filter((q) => q > 0));
  const caps: BulkCap[] = [];
  const factors = new Map<number, number>();
  if (baseline > 0) {
    const threshold = Math.max(BULK_ABS_FLOOR, BULK_MULT * baseline);
    const target = Math.max(BULK_ABS_FLOOR - 1, Math.round(BULK_CAP_MULT * baseline));
    for (const [key, day] of days) {
      if (day.total <= threshold) continue;
      const capped = Math.min(day.total, target);
      caps.push({ date: new Date(key), original: day.total, capped, baseline, threshold,
        multiple: Math.round(day.total / baseline * 10) / 10, evidence: "daily_total" });
      // Preserve return rows while reducing only positive contributions; the
      // net day still sums exactly to the target when returns are present.
      factors.set(key, (capped - day.negative) / day.positive);
    }
  }
  return {
    series: history.map((point) => {
      const factor = factors.get(dayKeyOf(point.date));
      return { ...point, quantity: factor !== undefined && point.quantity > 0 ? point.quantity * factor : point.quantity };
    }),
    caps: caps.sort((a, b) => +a.date - +b.date),
  };
}

export function hasBulkBuy(history: SalesPoint[], opts?: DebulkOptions): boolean {
  return debulkSeries(history, opts).caps.length > 0;
}
