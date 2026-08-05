/**
 * Presentation helpers for the notification feed. Pure and client-safe — no
 * server imports, so the bell (a client component) can share them with tests.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Compact relative timestamp: "just now", "5m ago", "3h ago", "2d ago",
 *  then a short date ("12 Jun") past a week. Future/invalid → "just now". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "just now";
  const elapsed = now - then;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(then).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export type NotificationTone = "negative" | "warning" | "neutral";

/** Feed styling per notification kind; unknown kinds render neutrally. */
export function kindTone(kind: string): NotificationTone {
  switch (kind) {
    case "sync_failed":
      return "negative";
    case "shopify_reconnect":
    case "shopify_uninstalled":
    case "cost_moved":
    case "accuracy_drop":
    // The plan on screen is last-but-one night's until the run succeeds.
    case "forecast_failed":
    // A new product with no cost is held off the buy list until someone sets
    // one, so this is something to act on rather than merely to know.
    case "catalogue_review":
      return "warning";
    default:
      return "neutral";
  }
}
