/**
 * The period the Reports screen is looking at.
 *
 * Every figure on that screen used to be a fixed window with no way to change
 * it — top earners was always 30 days, the stockout trend always 8 weeks, and
 * adherence always 60 days, none of it stated and none of it adjustable. The
 * range now travels in the URL, so a period is shareable and survives a reload,
 * the same way the view tabs already work.
 *
 * Presets and explicit inclusive date ranges resolve in the tenant timezone.
 * Day-labelled sales/snapshots and actual event timestamps use different
 * boundary representations so both describe the same trading-date selection.
 */

export const RANGE_KEYS = ["7d", "30d", "90d", "180d", "365d"] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

/** What the screen shows when nothing is asked for — the window every figure
 *  used to be hardcoded to, so an unparameterised link reads as it always did. */
export const DEFAULT_RANGE: RangeKey = "30d";

/** Days in each range, and the words for it. One record, not two lookups in
 *  different files: a key present in one and missing from the other is the
 *  shape of defect this codebase keeps producing. */
const RANGES: Record<RangeKey, { days: number; label: string; short: string }> = {
  "7d": { days: 7, label: "Last 7 days", short: "7d" },
  "30d": { days: 30, label: "Last 30 days", short: "30d" },
  "90d": { days: 90, label: "Last 90 days", short: "90d" },
  "180d": { days: 180, label: "Last 6 months", short: "6m" },
  "365d": { days: 365, label: "Last 12 months", short: "12m" },
};

/**
 * The range a URL is asking for.
 *
 * Anything unrecognised falls back to the default rather than throwing: this
 * reads a query string, which any visitor can type, and a report that 500s on a
 * mistyped parameter is worse than one that shows its usual month.
 */
export function parseRangeKey(raw: string | null | undefined): RangeKey {
  return (RANGE_KEYS as readonly string[]).includes(raw ?? "") ? (raw as RangeKey) : DEFAULT_RANGE;
}

export function rangeDays(key: RangeKey): number {
  return RANGES[key].days;
}

export function rangeLabel(key: RangeKey): string {
  return RANGES[key].label;
}

export function rangeShortLabel(key: RangeKey): string {
  return RANGES[key].short;
}

/** Whole weeks covered, for the panels that bucket by week. At least one, so a
 *  short range asks for a week rather than for nothing. */
export function rangeWeeks(key: RangeKey): number {
  return Math.max(1, Math.round(rangeDays(key) / 7));
}

/** Sales/snapshot dates are tenant-day labels stored at UTC midnight. Order
 * and recommendation timestamps are real instants, hence the separate pair. */
export type ReportRange = {
  start: Date;
  endExclusive: Date;
  startInstant: Date;
  endInstant: Date;
  from: string;
  to: string;
  days: number;
  label: string;
  custom: boolean;
  error?: string;
};

const DAY_MS = 86400000;
function validDay(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null;
}

function tenantToday(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Resolve local midnight independently at either end (DST days need not be
 * 24 hours long). Never use the execution host's local timezone. */
function midnightInstant(marker: Date, timezone: string): Date {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let instant = +marker;
  for (let i = 0; i < 4; i++) {
    const parts = format.formatToParts(new Date(instant));
    const get = (name: string) => Number(parts.find((p) => p.type === name)!.value);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const next = instant + (+marker - local);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

export function resolveReportRange(
  params: { range?: string; from?: string; to?: string },
  timezone: string,
  now: Date = new Date()
): ReportRange {
  const todayKey = tenantToday(timezone, now);
  const today = validDay(todayKey)!;
  let from = validDay(params.from);
  let to = validDay(params.to);
  let error: string | undefined;
  const requested = !!(params.from || params.to);
  if (requested) {
    if (!from || !to) error = "Enter a valid start and end date.";
    else if (from > to) error = "The start date must be on or before the end date.";
    else if (to > today) error = "The end date cannot be after today in your shop's timezone.";
    else if ((+to - +from) / DAY_MS + 1 > 366) error = "Choose a date range of up to 366 days.";
  }
  const custom = requested && !error;
  if (!custom) {
    to = today;
    from = new Date(+today - (rangeDays(parseRangeKey(params.range)) - 1) * DAY_MS);
  }
  const start = from!;
  const endExclusive = new Date(+to! + DAY_MS);
  const fromKey = start.toISOString().slice(0, 10);
  const toKey = to!.toISOString().slice(0, 10);
  return { start, endExclusive, startInstant: midnightInstant(start, timezone), endInstant: midnightInstant(endExclusive, timezone),
    from: fromKey, to: toKey, days: Math.round((+endExclusive - +start) / DAY_MS),
    label: `${fromKey} to ${toKey}`, custom, ...(error ? { error } : {}) };
}
