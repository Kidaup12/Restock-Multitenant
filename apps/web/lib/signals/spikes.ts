/**
 * The "was this a promo?" dismissal key.
 *
 * A day the owner has answered "one-off" must stop being asked about, and that
 * answer has to outlive the page. `IgnoreRule` already holds "stop telling me
 * about this" facts keyed by kind + value, so a spike dismissal is one more
 * kind rather than a new table.
 *
 * Reader and writer share this module so the two can never disagree about the
 * shape of the key — a mismatch would silently re-ask a question the owner has
 * already answered.
 */

export const SPIKE_IGNORE_KIND = "spike_day";

/** `<productId>:<YYYY-MM-DD>` — one answer per product per day. */
export function spikeKey(productId: string, dayKey: string): string {
  return `${productId}:${dayKey}`;
}
