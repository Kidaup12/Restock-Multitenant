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

/** Null for a healthy store — the banner is for the exceptions, and a green
 *  "everything is fine" bar on every page is just furniture. */
export function connectionNotice(state: ConnectionState): Notice | null {
  switch (state) {
    case "live":
      return null;
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
}: {
  state: ConnectionState;
  canFix: boolean;
}) {
  const notice = connectionNotice(state);
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
