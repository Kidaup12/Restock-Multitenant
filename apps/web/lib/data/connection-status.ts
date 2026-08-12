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
   * When a sync phase last COMPLETED, across resources — the newest ingest
   * cursor. A connection can be perfectly "live" and still be sending nothing,
   * which is the case the shop was never told about. Null = never synced.
   *
   * The cursor rather than the run: it only advances after a phase succeeds, so
   * a store that fails every 15 minutes cannot look fresh.
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
    db.ingestCursor.findFirst({
      where: { source: "shopify" },
      orderBy: { cursor: "desc" },
      select: { cursor: true },
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
    lastSyncedAt: freshest?.cursor ?? null,
  };
}
