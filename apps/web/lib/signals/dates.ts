/**
 * Day-key helpers for the declared-signal surfaces. Promo windows and closures
 * are both entered as a plain "YYYY-MM-DD" range and stored against the same
 * UTC-midnight day markers the sales history uses (see @wezesha/pos time.ts).
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The engine drops a promo window after this many days (promo-windows.ts), so
 *  accepting a longer one would silently ignore the tail. */
export const MAX_PROMO_DAYS = 366;
/** A closure writes one row per day; a mistyped year must not blank a season. */
export const MAX_CLOSURE_DAYS = 120;

export function isDayKey(value: string): boolean {
  return DAY_KEY.test(value);
}

/** Inclusive day keys from `from` to `to`. Empty when either end is malformed,
 *  the range runs backwards, or it is longer than `maxDays`. */
export function dayKeysInRange(from: string, to: string, maxDays: number): string[] {
  if (!DAY_KEY.test(from) || !DAY_KEY.test(to)) return [];
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  if ((end - start) / DAY_MS + 1 > maxDays) return [];
  const keys: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) keys.push(new Date(t).toISOString().slice(0, 10));
  return keys;
}
