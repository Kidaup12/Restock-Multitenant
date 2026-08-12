import Link from "next/link";
import type { ConnectionState } from "@/lib/admin/fleet";

/**
 * "Your numbers have stopped moving", said above every screen rather than only
 * inside Settings. A shop that cannot see this keeps making buying decisions off
 * whatever the last successful sync left behind, and nothing on the page looks
 * wrong.
 *
 * Not money, so it shows for every role — but the fix lives behind
 * `manage_settings`, and pointing someone at a screen they cannot open is worse
 * than not pointing them anywhere.
 */

type Notice = { message: string; action: string };

/** How long the store has been quiet, resolved on the server. Null when the
 *  data is current — the clock cannot live in here (react-hooks/purity bans
 *  Date.now() during render), so the caller does the arithmetic. */
export type Staleness = { days: number | null };

/** Null for a healthy store — the banner is for the exceptions, and a green
 *  "everything is fine" bar on every page is just furniture. */
export function connectionNotice(
  state: ConnectionState,
  stale: Staleness | null = null
): Notice | null {
  switch (state) {
    case "live":
      // Connected and still silent. This is the dangerous one: nothing on the
      // page looks wrong, every figure renders, and the shop keeps buying
      // against whatever the last successful sync left behind. The operator
      // fleet has flagged this for months; the shop was never told.
      if (!stale) return null;
      return {
        message:
          stale.days === null
            ? "Shopify is connected but has never sent any data — stock and sales figures are empty."
            : stale.days < 2
              ? "No update from Shopify in over a day — these stock and sales figures may be out of date."
              : `No update from Shopify in ${stale.days} days — these stock and sales figures may be out of date.`,
        action: "Check the connection",
      };
    case "none":
      return {
        message: "Shopify isn't connected yet — stock and sales aren't syncing.",
        action: "Connect a store",
      };
    case "uninstalled":
      return {
        message: "Shopify is disconnected — stock and sales aren't syncing.",
        action: "Reconnect",
      };
    case "paused":
      return {
        message:
          "Shopify syncing is paused — the store kept refusing our access, so these numbers are frozen.",
        action: "Reconnect",
      };
  }
}

export function ConnectionBanner({
  state,
  canFix,
  stale = null,
}: {
  state: ConnectionState;
  canFix: boolean;
  /** Set only when the store is connected but has stopped sending. */
  stale?: Staleness | null;
}) {
  const notice = connectionNotice(state, stale);
  if (!notice) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-warning bg-warning-soft px-4 py-2 text-sm text-warning"
    >
      <span>{notice.message}</span>
      {canFix && (
        <Link href="/settings/connections" className="font-medium underline underline-offset-2">
          {notice.action} →
        </Link>
      )}
    </div>
  );
}
