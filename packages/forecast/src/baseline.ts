/**
 * Demand-rate and inventory primitives. Everything here is a pure function of
 * the sales history and plain numeric facts passed in.
 */

/** One day of sales for one product. The engine reads date + quantity; revenue
 *  and channel ride along so callers can pass their sales rows unmodified. */
export type SalesPoint = {
  date: Date;
  quantity: number;
  revenueKes?: number;
  channel?: string;
};

/** Recency weighting used by every windowed rate: recent sales dominate, the
 *  trailing year still anchors slow movers. */
const RATE_WINDOWS: ReadonlyArray<{ days: number; weight: number }> = [
  { days: 30, weight: 0.5 },
  { days: 90, weight: 0.3 },
  { days: 365, weight: 0.2 },
];

export function weightedDailyRate(history: SalesPoint[], asOf: Date = new Date()): number {
  if (history.length === 0) return 0;
  let weighted = 0;
  for (const w of RATE_WINDOWS) {
    const since = new Date(asOf);
    since.setUTCDate(since.getUTCDate() - w.days);
    const qty = history.filter((p) => p.date >= since).reduce((s, p) => s + p.quantity, 0);
    weighted += (qty / w.days) * w.weight;
  }
  return weighted;
}

/** UTC-midnight epoch (ms) for a date's day-key. */
export function dayKeyOf(d: Date): number {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime();
}

/** Count of day-keys in the set falling inside [since, asOf). */
function countDayKeysInWindow(keys: Set<number>, since: Date, asOf: Date): number {
  const lo = since.getTime();
  const hi = asOf.getTime();
  let n = 0;
  for (const k of keys) if (k >= lo && k < hi) n++;
  return n;
}

/** DISTINCT count of blocked day-keys — proven out-of-stock (stockoutDates) ∪
 *  excluded promo/closure days — inside [since, asOf). With no excluded days
 *  this is exactly censoredDaysInWindow, so the stockout-only path is unchanged. */
export function blockedDaysInWindow(
  stockoutDates: Date[],
  excludedDates: Date[] | undefined,
  since: Date,
  asOf: Date
): number {
  if (!excludedDates?.length) return censoredDaysInWindow(stockoutDates, since, asOf);
  const lo = since.getTime();
  const hi = asOf.getTime();
  const seen = new Set<number>();
  for (const d of stockoutDates) {
    const k = dayKeyOf(d);
    if (k >= lo && k < hi) seen.add(k);
  }
  for (const d of excludedDates) {
    const k = dayKeyOf(d);
    if (k >= lo && k < hi) seen.add(k);
  }
  return seen.size;
}

/** Count calendar days inside a window consumed by stockout gaps — runs of 7+
 *  consecutive days with no sale record for a product that normally sells. The
 *  gap days are excluded from the denominator so the rate reflects demand WHEN
 *  IN STOCK, not demand diluted by empty shelves. Excluded promo/closure days
 *  sitting inside a gap are dropped here so the caller's separate excluded-day
 *  subtraction counts them once, not twice. */
function gapDaysInWindow(
  history: SalesPoint[],
  since: Date,
  asOf: Date,
  minGap = 7,
  excludedDates?: Date[]
): number {
  const inWindow = history
    .filter((p) => p.date >= since && p.date < asOf)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (inWindow.length < 2) return 0;
  const windowDays = Math.round((asOf.getTime() - since.getTime()) / 86400000);
  const totalQty = inWindow.reduce((s, p) => s + p.quantity, 0);
  if (totalQty / windowDays < 0.5) return 0; // below ~15/month: gaps are natural, not stockouts
  const excluded = excludedDates?.length ? new Set(excludedDates.map(dayKeyOf)) : null;
  let gap = 0;
  for (let i = 0; i < inWindow.length - 1; i++) {
    const a = inWindow[i]!.date.getTime();
    const b = inWindow[i + 1]!.date.getTime();
    const between = Math.round((b - a) / 86400000);
    if (between > minGap) {
      let span = between - 1;
      if (excluded) for (const k of excluded) if (k > a && k < b) span--; // closure inside gap
      gap += span;
    }
  }
  return Math.min(gap, windowDays - 1); // never exclude the whole window
}

/** Like weightedDailyRate but removes inferred stockout gap days from each
 *  window's denominator, preventing prolonged out-of-stock periods from
 *  deflating the run rate and causing chronic under-ordering. `excludedDates`
 *  (promo-spike ∪ closure day-keys) are dropped from BOTH the numerator (their
 *  sales don't inflate the sum) and the denominator (their days don't dilute it),
 *  de-duplicated against the gap subtraction. Empty/absent -> unchanged. */
export function weightedDailyRateAdjusted(
  history: SalesPoint[],
  asOf: Date = new Date(),
  excludedDates?: Date[]
): number {
  if (history.length === 0) return 0;
  const excluded = excludedDates?.length ? new Set(excludedDates.map(dayKeyOf)) : null;
  let weighted = 0;
  for (const w of RATE_WINDOWS) {
    const since = new Date(asOf);
    since.setUTCDate(since.getUTCDate() - w.days);
    const qty = history
      .filter((p) => p.date >= since && (!excluded || !excluded.has(dayKeyOf(p.date))))
      .reduce((s, p) => s + p.quantity, 0);
    const excludedDays = excluded ? countDayKeysInWindow(excluded, since, asOf) : 0;
    const effectiveDays = Math.max(
      1,
      w.days - gapDaysInWindow(history, since, asOf, 7, excludedDates) - excludedDays
    );
    weighted += (qty / effectiveDays) * w.weight;
  }
  return weighted;
}

/** Public view of the gap-inference used by the adjusted rate: inferred
 *  stockout gap-days in [since, asOf) for a product that normally sells. Feeds
 *  the confidence word's stockout-gap share when no snapshot mask is available. */
export function inferredStockoutGapDays(history: SalesPoint[], since: Date, asOf: Date): number {
  return gapDaysInWindow(history, since, asOf);
}

/** Count of censored (proven out-of-stock) day-keys falling inside [since, asOf). */
export function censoredDaysInWindow(stockoutDates: Date[], since: Date, asOf: Date): number {
  let n = 0;
  for (const d of stockoutDates) if (d >= since && d < asOf) n++;
  return n;
}

/**
 * Snapshot-truth version of weightedDailyRateAdjusted: instead of INFERRING
 * stockouts from sale gaps, remove the days inventory snapshots PROVE the shelf
 * was empty from each window's denominator. An empty mask falls back to the
 * gap-inference variant (covers history from before snapshots existed).
 */
export function weightedDailyRateCensored(
  history: SalesPoint[],
  stockoutDates: Date[],
  asOf: Date = new Date(),
  excludedDates?: Date[]
): number {
  if (history.length === 0) return 0;
  if (stockoutDates.length === 0) return weightedDailyRateAdjusted(history, asOf, excludedDates);
  const excluded = excludedDates?.length ? new Set(excludedDates.map(dayKeyOf)) : null;
  let weighted = 0;
  for (const w of RATE_WINDOWS) {
    const since = new Date(asOf);
    since.setUTCDate(since.getUTCDate() - w.days);
    const inWin = history.filter((p) => p.date >= since && (!excluded || !excluded.has(dayKeyOf(p.date))));
    const qty = inWin.reduce((s, p) => s + p.quantity, 0);
    // Blocked = proven stockout ∪ excluded promo/closure, distinct so a day that
    // is both is subtracted once.
    const blocked = blockedDaysInWindow(stockoutDates, excludedDates, since, asOf);
    const saleDays = inWin.filter((p) => p.quantity > 0).length;
    const effectiveDays = effectiveWindowDays(w.days, blocked, { inStockDays: w.days - blocked, saleDays });
    weighted += (qty / effectiveDays) * w.weight;
  }
  return weighted;
}

/** True if this product has at least one significant stockout gap in the past
 *  year — i.e. weightedDailyRateAdjusted would differ meaningfully from
 *  weightedDailyRate. */
export function hasStockoutGap(history: SalesPoint[], asOf: Date = new Date()): boolean {
  if (history.length < 2) return false;
  const since = new Date(asOf);
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  return gapDaysInWindow(history, since, asOf) > 0;
}

/** Denominator for a windowed rate: calendar days minus proven out-of-stock
 *  days, but never below a floor. The floor stops a couple of lucky days from
 *  extrapolating into a huge rate.
 *
 *  The floor ADAPTS to signal quality. A near-total-stockout item (out 27 of 30
 *  days) that sold on most of the few days it WAS in stock is a real seller,
 *  and a flat 7-day floor halves its rate — under-ordering exactly the items
 *  already starving. When the in-stock window carries CONSISTENT sales (sold on
 *  >=60% of in-stock days, and >=2 sale-days) a tighter floor (3 in-stock days)
 *  is trusted. Thin or one-off signal keeps the conservative 7-day floor. */
export function effectiveWindowDays(
  windowDays: number,
  stockoutDays: number,
  /** Signal quality from the in-stock days, when known. Omit -> flat 7 floor. */
  signal?: { inStockDays: number; saleDays: number }
): number {
  const inStock = windowDays - stockoutDays;
  let floor = Math.min(7, windowDays);
  if (signal && signal.inStockDays > 0) {
    const consistent = signal.saleDays >= 2 && signal.saleDays / signal.inStockDays >= 0.6;
    if (consistent) floor = Math.min(3, windowDays); // trust a tight, consistent window
  }
  return Math.max(inStock, floor);
}

/** Cover returned when the run rate is ~zero: "effectively forever", not a day
 *  count. It is a sentinel — screens and exports must translate it, never print
 *  it, so read-time consumers test against this rather than a bare 999. */
export const NO_STOCKOUT_DAYS = 999;

export function daysOfStockRemaining(currentStock: number, dailyRate: number): number {
  if (dailyRate <= 0.0001) return NO_STOCKOUT_DAYS;
  return Math.floor(currentStock / dailyRate);
}

/** Safety stock via King's formula: buffers both demand variability and
 *  lead-time variability at the service level implied by z. */
export function kingsSafetyStock(params: {
  z: number;
  leadTimeAvg: number;
  leadTimeStd: number;
  demandAvg: number;
  demandStd: number;
}): number {
  const variance =
    params.leadTimeAvg * Math.pow(params.demandStd, 2) +
    Math.pow(params.demandAvg, 2) * Math.pow(params.leadTimeStd, 2);
  return params.z * Math.sqrt(variance);
}

export function reorderPoint(demandAvg: number, leadTimeAvg: number, safetyStock: number): number {
  return demandAvg * leadTimeAvg + safetyStock;
}

/** Population standard deviation. */
export function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

export type Urgency = "critical" | "high" | "medium" | "low";

/**
 * Days-of-cover → urgency, velocity-gated. A SKU is only "critical" if it's
 * about to run out AND actually sells at a meaningful pace — a slow item at
 * zero stock (e.g. 0.03 units/day) is "high", not an emergency that
 * force-overflows the budget. The floor (~1 unit / 2 weeks) keeps genuine but
 * slow sellers out of the critical bucket. Pass `dailyRate` to enable the gate;
 * omit it for the day-only behavior.
 */
const CRITICAL_MIN_RATE = 1 / 14; // ~0.071/day — sells at least ~1 unit per 2 weeks
export function urgencyFromDays(days: number, dailyRate?: number): Urgency {
  if (days < 7) return dailyRate == null || dailyRate >= CRITICAL_MIN_RATE ? "critical" : "high";
  if (days < 14) return "high";
  if (days < 30) return "medium";
  return "low";
}

/** Default z per ABC service level: A ~99%, B ~95%, C ~90% one-sided. */
export const SERVICE_Z_DEFAULTS = { A: 2.33, B: 1.65, C: 1.28 } as const;

/** z for a product's ABC class. Tenant overrides (per class) win over the
 *  defaults; unknown/unclassified products take the C service level. */
export function zForServiceLevel(
  abc: string | null | undefined,
  overrides?: Partial<Record<"A" | "B" | "C", number | null>>
): number {
  if (abc === "A") return overrides?.A ?? SERVICE_Z_DEFAULTS.A;
  if (abc === "B") return overrides?.B ?? SERVICE_Z_DEFAULTS.B;
  return overrides?.C ?? SERVICE_Z_DEFAULTS.C;
}
