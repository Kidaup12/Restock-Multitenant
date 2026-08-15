import { prismaForTenant } from "@wezesha/db";
import type { ConnectionState } from "@/lib/admin/fleet";

/**
 * Whether this shop's data is still moving, for the banner that rides above
 * every screen.
 *
 * The state already existed — but only on the operator's fleet table and inside
 * Settings → Connections. So a shop whose sync had stopped could work a whole
 * session on frozen numbers and never be told: every figure still rendered, just
 * from the last successful pull. The forecast had the same shape of bug and cost
 * two silent nights; this is the same lesson on the sync side.
 *
 * Type-only import of `ConnectionState`: it erases at compile time, so nothing
 * from the admin module reaches this request path — the union simply has one
 * definition instead of two that can drift.
 */

export type ConnectionStatus = {
  state: ConnectionState;
  /** Null when no store was ever connected. */
  shopDomain: string | null;
  /**
   * When data last ARRIVED, across resources. Null = the store has never
   * delivered anything.
   *
   * Deliberately not the cursor. The cursor advances after every run whether or
   * not a row came back, so it answered "did a sync happen" — and every sync
   * happens, every fifteen minutes, for ever. Two production workspaces sat at
   * "synced two minutes ago" with newest sales three and twenty-four days old,
   * and this banner could not fire for either. `IngestCursor.dataAt` moves only
   * when a phase ingested something.
   *
   * Newest across resources, not oldest: the question is whether ANYTHING is
   * still arriving. A catalogue nobody has edited in a month is not a broken
   * connection, and telling a healthy shop its figures are frozen teaches it to
   * ignore the bar.
   */
  lastSyncedAt: Date | null;
};

/** One indexed read on a unique tenantId — this runs on every authenticated
 *  render, so it stays a single lookup and selects three columns. */
export async function getConnectionStatus(tenantId: string): Promise<ConnectionStatus> {
  const db = prismaForTenant(tenantId);
  const [connection, freshest] = await Promise.all([
    db.shopifyConnection.findFirst({
      select: { shopDomain: true, uninstalledAt: true, syncPausedAt: true },
    }),
    // Rows that have never delivered are excluded rather than sorted, so one
    // silent resource cannot be picked as "the newest" ahead of a live one.
    db.ingestCursor.findFirst({
      where: { source: "shopify", dataAt: { not: null } },
      orderBy: { dataAt: "desc" },
      select: { dataAt: true },
    }),
  ]);

  if (!connection) return { state: "none", shopDomain: null, lastSyncedAt: null };
  const state: ConnectionState = connection.uninstalledAt
    ? "uninstalled"
    : connection.syncPausedAt
      ? "paused"
      : "live";
  return {
    state,
    shopDomain: connection.shopDomain,
    lastSyncedAt: freshest?.dataAt ?? null,
  };
}
