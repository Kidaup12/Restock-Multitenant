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
};

/** One indexed read on a unique tenantId — this runs on every authenticated
 *  render, so it stays a single lookup and selects three columns. */
export async function getConnectionStatus(tenantId: string): Promise<ConnectionStatus> {
  const db = prismaForTenant(tenantId);
  const connection = await db.shopifyConnection.findFirst({
    select: { shopDomain: true, uninstalledAt: true, syncPausedAt: true },
  });

  if (!connection) return { state: "none", shopDomain: null };
  const state: ConnectionState = connection.uninstalledAt
    ? "uninstalled"
    : connection.syncPausedAt
      ? "paused"
      : "live";
  return { state, shopDomain: connection.shopDomain };
}
