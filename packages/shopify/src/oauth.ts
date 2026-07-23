import crypto from "node:crypto";

/**
 * Authorization-code OAuth for per-store installs — the multi-tenant path.
 * Tokens minted this way are OFFLINE tokens: they stay valid until the merchant
 * uninstalls the app, so one browser round-trip per store is the whole auth
 * story (unlike client-credentials grants, which are app-owned-store-only).
 */

/** Read scopes for the M3/M4 sync core. Write scopes arrive with their features. */
export const REQUIRED_SCOPES = [
  "read_products",
  "read_inventory",
  "read_orders",
  "read_locations",
] as const;

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/** Strict allow-list check — the shop param becomes a redirect target and an
 *  API host, so anything but a plain *.myshopify.com domain is rejected. */
export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

/** Unguessable per-install state nonce (round-tripped via an httpOnly cookie). */
export function generateOAuthState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(opts: {
  shop: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    scope: (opts.scopes ?? REQUIRED_SCOPES).join(","),
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://${opts.shop}/admin/oauth/authorize?${params.toString()}`;
}

export type TokenExchangeResult = { accessToken: string; scopes: string };

/** Exchange the callback `code` for the store's offline Admin API token. */
export async function exchangeCodeForToken(opts: {
  shop: string;
  clientId: string;
  clientSecret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenExchangeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`https://${opts.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Shopify token exchange failed (${res.status}) for ${opts.shop}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; scope?: string };
  if (!json.access_token) throw new Error("Shopify token exchange returned no access_token.");
  return { accessToken: json.access_token, scopes: json.scope ?? "" };
}
