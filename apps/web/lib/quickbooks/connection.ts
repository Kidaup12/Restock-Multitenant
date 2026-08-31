import { prismaForTenant } from "@wezesha/db";
import {
  QuickBooksAuthError,
  decryptToken,
  encryptToken,
  refreshAccessToken,
  revokeToken,
  type QuickBooksTokens,
} from "@wezesha/quickbooks";

/**
 * A workspace's QuickBooks connection: stored encrypted, refreshed in one place.
 *
 * Everything here goes through `prismaForTenant`, so RLS is what keeps one
 * workspace's accounting tokens away from another — not the `where` clauses.
 */

/** Persist a fresh token pair from the install round trip. */
export async function saveConnection(
  tenantId: string,
  realmId: string,
  tokens: QuickBooksTokens
): Promise<void> {
  const db = prismaForTenant(tenantId);
  const stored = {
    realmId,
    accessToken: encryptToken(tokens.accessToken),
    refreshToken: encryptToken(tokens.refreshToken),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    scopes: tokens.scopes,
    // A reconnect clears whatever went wrong last time — that is the whole
    // point of reconnecting, and leaving the pause set would strand a
    // connection the owner has just fixed.
    disconnectedAt: null,
    authFailureCount: 0,
    syncPausedAt: null,
    lastAuthErrorAt: null,
    lastAuthError: null,
  };
  await db.quickBooksConnection.upsert({
    where: { tenantId },
    create: { tenantId, connectedAt: new Date(), ...stored },
    update: stored,
  });
}

/** Remember why a connection stopped working, and stop retrying a dead grant. */
export async function recordAuthFailure(
  tenantId: string,
  message: string,
  unrecoverable: boolean
): Promise<void> {
  const db = prismaForTenant(tenantId);
  const now = new Date();
  await db.quickBooksConnection.updateMany({
    where: { tenantId },
    data: {
      authFailureCount: { increment: 1 },
      lastAuthErrorAt: now,
      lastAuthError: message.slice(0, 500),
      // Only a dead grant pauses. A 500 or a timeout is worth retrying, and
      // pausing on one would strand a healthy connection until someone noticed.
      ...(unrecoverable ? { syncPausedAt: now } : {}),
    },
  });
}

export type ActiveToken = { accessToken: string; realmId: string };

/**
 * An access token good right now, refreshing first if it has expired.
 *
 * **The rotation lives here, in one place.** Intuit issues a new refresh token
 * on every refresh and invalidates the one it was given, so the update writes
 * BOTH tokens together. Persisting only the access token would leave a
 * connection that works for an hour and then fails permanently with an error
 * that reads exactly like the customer revoking us — a misreading this codebase
 * has already paid for once with Shopify's expiring tokens.
 *
 * Null means "cannot be used": no connection, disconnected, paused after a dead
 * grant, or the refresh token itself past its life. Callers surface that as
 * "reconnect QuickBooks" rather than retrying.
 */
export async function activeAccessToken(
  tenantId: string,
  now: Date = new Date()
): Promise<ActiveToken | null> {
  const db = prismaForTenant(tenantId);
  const row = await db.quickBooksConnection.findFirst({
    where: { tenantId },
    select: {
      realmId: true,
      accessToken: true,
      refreshToken: true,
      accessTokenExpiresAt: true,
      refreshTokenExpiresAt: true,
      disconnectedAt: true,
      syncPausedAt: true,
    },
  });
  if (!row || row.disconnectedAt || row.syncPausedAt) return null;

  // A minute's headroom: a token that expires mid-request is the same problem
  // as one that expired a minute ago, and costs a whole sync to discover.
  const SKEW_MS = 60_000;
  if (row.accessTokenExpiresAt.getTime() - SKEW_MS > now.getTime()) {
    return { accessToken: decryptToken(row.accessToken), realmId: row.realmId };
  }
  if (row.refreshTokenExpiresAt.getTime() <= now.getTime()) {
    await recordAuthFailure(tenantId, "refresh token expired", true);
    return null;
  }

  let tokens: QuickBooksTokens;
  try {
    tokens = await refreshAccessToken({ refreshToken: decryptToken(row.refreshToken), now });
  } catch (err) {
    const unrecoverable = err instanceof QuickBooksAuthError && err.unrecoverable;
    await recordAuthFailure(tenantId, err instanceof Error ? err.message : "refresh failed", unrecoverable);
    return null;
  }

  await db.quickBooksConnection.updateMany({
    where: { tenantId },
    data: {
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptToken(tokens.refreshToken),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      authFailureCount: 0,
      lastAuthErrorAt: null,
      lastAuthError: null,
    },
  });
  return { accessToken: tokens.accessToken, realmId: row.realmId };
}

/**
 * Hand the grant back and clear the row.
 *
 * The revoke is best-effort: a workspace that pressed Disconnect must end up
 * disconnected even if Intuit is unreachable, so the local state is cleared
 * either way. Returns whether Intuit accepted the revoke so the screen can say
 * which of the two happened instead of implying the stronger one.
 */
export async function disconnect(tenantId: string): Promise<{ revoked: boolean }> {
  const db = prismaForTenant(tenantId);
  const row = await db.quickBooksConnection.findFirst({
    where: { tenantId },
    select: { refreshToken: true },
  });
  if (!row) return { revoked: false };

  let revoked = false;
  try {
    revoked = await revokeToken({ token: decryptToken(row.refreshToken) });
  } catch {
    revoked = false;
  }
  await db.quickBooksConnection.updateMany({
    where: { tenantId },
    data: { disconnectedAt: new Date(), syncPausedAt: new Date() },
  });
  return { revoked };
}
