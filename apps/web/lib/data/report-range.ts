/**
 * The period the Reports screen is looking at.
 *
 * Every figure on that screen used to be a fixed window with no way to change
 * it — top earners was always 30 days, the stockout trend always 8 weeks, and
 * adherence always 60 days, none of it stated and none of it adjustable. The
 * range now travels in the URL, so a period is shareable and survives a reload,
 * the same way the view tabs already work.
 *
 * ROLLING windows only, deliberately. Calendar-anchored ranges ("this month",
 * "year to date") are only correct in the shop's own timezone — a tenant carries
 * one (`Tenant.timezone`, default Africa/Nairobi) and it is not currently
 * threaded into this layer, so anchoring on UTC month boundaries would quietly
 * report the wrong day's takings at both ends. Rolling counts of days have no
 * such boundary and answer the question that was actually being asked. Calendar
 * ranges are worth adding once the timezone is plumbed through.
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
