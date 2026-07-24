/**
 * Tenant-timezone day boundaries. The spec pins the sales day to the tenant's
 * timezone (Africa/Nairobi), NOT UTC: a till sale rung at 23:30 Nairobi is that
 * day's sale, and bucketing it in UTC would push it onto the next calendar day
 * and split a single trading day across two rows.
 *
 * SalesHistory stores the day as a UTC-midnight marker for the tenant-local day
 * (matching how the rest of the app reads the date column as a plain day key —
 * see lib/data/sales.ts), so `dayMarker` turns a day key into that marker.
 */

/** The tenant-local calendar day of `date`, as "YYYY-MM-DD". Uses Intl so DST /
 *  offset rules come from the IANA zone, not a hardcoded offset. */
export function tenantDayKey(timezone: string, date: Date): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the key we want.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

/** The stored SalesHistory date for a "YYYY-MM-DD" day key: UTC midnight. */
export function dayMarker(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

/** UTC-instant offset (ms) of `timezone` at `date`: local = utc + offset. */
function tzOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const asUtc = Date.UTC(m.year!, m.month! - 1, m.day!, m.hour!, m.minute!, m.second!);
  return asUtc - date.getTime();
}

/** The UTC instant whose wall-clock in `timezone` is the given local time. */
function zonedWallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timezone: string
): Date {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(utcGuess - tzOffsetMs(new Date(utcGuess), timezone));
}

/**
 * Parse a POS sale timestamp to a real instant. A string carrying an explicit
 * offset (or Z) is trusted; a naive wall-clock string ("2026-06-12 19:00:29")
 * is interpreted in the TENANT timezone — parsing it as UTC or machine-local
 * would push late-evening sales onto the wrong trading day. A Date is returned
 * as-is.
 */
export function parsePosDate(value: string | Date, timezone: string): Date {
  if (value instanceof Date) return value;
  const s = value.trim();
  if (/([zZ])$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const dt = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (dt) {
    return zonedWallClockToUtc(
      Number(dt[1]),
      Number(dt[2]),
      Number(dt[3]),
      Number(dt[4]),
      Number(dt[5]),
      Number(dt[6] ?? "0"),
      timezone
    );
  }
  const dOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dOnly) {
    return zonedWallClockToUtc(Number(dOnly[1]), Number(dOnly[2]), Number(dOnly[3]), 0, 0, 0, timezone);
  }
  return new Date(s);
}
