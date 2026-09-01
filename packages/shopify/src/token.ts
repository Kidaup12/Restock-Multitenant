/**
 * Minting Admin API tokens with the OAuth **client-credentials** grant.
 *
 *   POST https://{shop}/admin/oauth/access_token
 *   { grant_type: "client_credentials", client_id, client_secret }
 *   -> { access_token: "shpat_…", scope, expires_in: 86399 }
 *
 * Why this exists, and why it replaced storing a token:
 *
 * A token minted this way lives about **24 hours**. We stored one as though it
 * were permanent, so every connected store began answering 403 roughly a day
 * after it was connected, and the error Shopify returns for an expired token
 * reads "token revoked or app uninstalled" — which sent three separate
 * investigations after a revocation that never happened. Minting on demand and
 * caching until shortly before expiry removes the failure mode outright: there
 * is no stored credential left to go stale.
 *
 * It also sidesteps the browser authorization-code flow entirely. That flow
 * needs an app whose distribution and listing are set up, which is why
 * "Reconnect" could never complete for a Dev Dashboard custom app. The
 * client-credentials grant needs no redirect, no listing and no review — only
 * the client id and secret of an app installed on that store.
 *
 * The durable credential is therefore the client secret, held per workspace
 * (ShopifyAppCredential), never a token.
 */

/** Refresh this long before the stated expiry, so a long backfill cannot have a
 *  token die mid-run. */
const EXPIRY_SAFETY_MS = 60_000;

export type MintedToken = { accessToken: string; scopes: string[]; expiresAt: number };

export type ShopifyAppCredentials = { clientId: string; clientSecret: string };

import { ShopifyRateLimitedError } from "./client";

export class ShopifyGrantError extends Error {
  readonly status: number;
  constructor(status: number, shopDomain: string, detail: string) {
    super(`Shopify rejected the app credentials (${status}) for ${shopDomain}: ${detail}`);
    this.name = "ShopifyGrantError";
    this.status = status;
  }
}

export async function mintAdminToken(
  shopDomain: string,
  credentials: ShopifyAppCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<MintedToken> {
  const res = await fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 429 is Shopify asking us to slow down, not refusing the credentials.
    // Raised as a grant error it would count as an auth failure and, after
    // enough of them, PAUSE a perfectly good connection and tell the shop to
    // reconnect — turning our own retry rate into "your store rejected us".
    if (res.status === 429) {
      const raw = res.headers.get("Retry-After");
      const seconds = raw ? Number.parseFloat(raw) : Number.NaN;
      const retryAfterMs =
        Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 2_000;
      throw new ShopifyRateLimitedError(retryAfterMs, `minting a token for ${shopDomain}`);
    }
    throw new ShopifyGrantError(res.status, shopDomain, body.slice(0, 200));
  }

  const json = (await res.json()) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new ShopifyGrantError(res.status, shopDomain, "no access_token in the grant response");
  }

  // A grant that omits expires_in is treated as short-lived rather than
  // permanent: re-minting costs one request, assuming permanence is what broke.
  const lifetimeMs = Math.max(0, (json.expires_in ?? 3600) * 1000 - EXPIRY_SAFETY_MS);
  return {
    accessToken: json.access_token,
    scopes: (json.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    expiresAt: Date.now() + lifetimeMs,
  };
}

/**
 * Process-local token cache. Deliberately in memory and not in the database:
 * a persisted short-lived token is exactly the bug this replaces, and a worker
 * restart losing its cache costs one extra request per shop.
 */
export function createTokenCache(
  mint: (shopDomain: string, credentials: ShopifyAppCredentials) => Promise<MintedToken> = (d, c) =>
    mintAdminToken(d, c),
  now: () => number = Date.now
) {
  const cache = new Map<string, MintedToken>();

  return {
    async get(shopDomain: string, credentials: ShopifyAppCredentials): Promise<string> {
      const hit = cache.get(shopDomain);
      if (hit && hit.expiresAt > now()) return hit.accessToken;
      const fresh = await mint(shopDomain, credentials);
      cache.set(shopDomain, fresh);
      return fresh.accessToken;
    },
    /** Drop a shop's token so the next call re-mints — used when Shopify answers
     *  401/403 despite a cached token that had not reached its stated expiry. */
    invalidate(shopDomain: string) {
      cache.delete(shopDomain);
    },
    get size() {
      return cache.size;
    },
  };
}
