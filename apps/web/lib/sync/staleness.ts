/**
 * When has a store gone quiet?
 *
 * One threshold, read by the operator fleet AND by the shop's own banner. It
 * lived in `lib/admin/fleet.ts` and was therefore operator-only: we could see a
 * store had stopped sending while the shop itself was shown nothing, and kept
 * buying against whatever the last successful sync left behind.
 *
 * It measures the SYNC, not the trading. The cursor advances only after a phase
 * completes, so a quiet shop that is still syncing is not stale — which is the
 * distinction that makes this safe to put in front of a customer. A shop with no
 * sales for a day would otherwise be told its data was broken.
 */

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Never-synced or older than the threshold. The clock is a parameter: React's
 *  purity rule bans `Date.now()` during render, so callers resolve it on the
 *  server and pass the answer down. */
export function isStale(at: Date | null, now: number = Date.now()): boolean {
  return !at || now - at.getTime() > STALE_AFTER_MS;
}

/** Whole days since `at`, floored — "no update in 3 days". Returns null when
 *  there has never been a sync, which reads differently and says so. */
export function staleDays(at: Date | null, now: number = Date.now()): number | null {
  if (!at) return null;
  return Math.floor((now - at.getTime()) / (24 * 60 * 60 * 1000));
}
