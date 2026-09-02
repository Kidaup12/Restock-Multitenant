/**
 * When has a store gone quiet?
 *
 * One threshold, read by the operator fleet AND by the shop's own banner. It
 * lived in `lib/admin/fleet.ts` and was therefore operator-only: we could see a
 * store had stopped sending while the shop itself was shown nothing, and kept
 * buying against whatever the last successful sync left behind.
 *
 * It measures ARRIVAL, not the run. It used to key on the cursor, on the
 * reasoning that a cursor advances only after a phase completes — but a phase
 * completes just as happily on an empty answer, so the cursor was stamped every
 * fifteen minutes forever and this threshold could never be crossed by the case
 * it exists for: a connected store that has gone silent. Four of five live
 * workspaces sat in that state, each reporting a timestamp from minutes ago.
 *
 * Arrival is `IngestCursor.dataAt`, moved only when a phase actually brought
 * something back. A shop that trades quietly still resets it through catalogue
 * edits and stock movement, so this stays a signal about the pipe rather than
 * about the till — but a genuinely dead day now does reach the shop, which is
 * the trade the old design avoided by never firing at all.
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

/**
 * "7h ago" — how long since anything arrived, for the always-on rail line.
 *
 * The banner only speaks once a store has gone quiet for a day, which answers
 * "is this broken?" but never "is this current?". A shop deciding what to buy
 * needs the second question answered on every screen, and the honest answer to
 * it is usually "an hour ago" rather than silence.
 *
 * Same clock-as-a-parameter rule as the rest of this module: React's purity
 * rule bans Date.now() during render, so the caller resolves it server-side.
 */
export function syncedAgo(at: Date | null, now: number = Date.now()): string | null {
  if (!at) return null;
  const ms = Math.max(0, now - at.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
