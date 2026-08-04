import type { ShopifyClient } from "./client";
import { REQUIRED_SCOPES } from "./oauth";

/**
 * Ask a store to prove a token works, and say what it is allowed to do.
 *
 * This is the check behind connecting a store by pasting a token and behind the
 * "Test connection" button. It exists because the alternative — write the token
 * and find out on the next sync — puts the answer fifteen minutes away from the
 * person who can fix it, in a worker log they cannot see.
 *
 * Two queries rather than one. `shop` proves the token is accepted and gives us
 * something human to echo back ("connected to Amara Beauty, KES"), which is how
 * someone catches pasting the token for a different store. `currentAppInstallation`
 * reports the scopes actually granted, so a token missing read_inventory is named
 * as such here instead of surfacing later as a sync that reads no stock.
 */

export type ConnectionProbe = {
  shopName: string | null;
  currencyCode: string | null;
  grantedScopes: string[];
  /** Required scopes the token does NOT carry. Empty means it can do the job. */
  missingScopes: string[];
};

export async function probeConnection(client: ShopifyClient): Promise<ConnectionProbe> {
  const data = await client.graphql<{
    shop?: { name?: string | null; currencyCode?: string | null };
    currentAppInstallation?: { accessScopes?: Array<{ handle?: string | null }> | null };
  }>(`query {
    shop { name currencyCode }
    currentAppInstallation { accessScopes { handle } }
  }`);

  const code = data.shop?.currencyCode?.trim().toUpperCase();
  const granted = (data.currentAppInstallation?.accessScopes ?? [])
    .map((s) => s?.handle?.trim())
    .filter((h): h is string => Boolean(h));

  // read_all_orders is a superset of read_orders: a token carrying it satisfies
  // the orders requirement even though the handle differs.
  const satisfies = (required: string) =>
    granted.includes(required) ||
    (required === "read_orders" && granted.includes("read_all_orders"));

  return {
    shopName: data.shop?.name?.trim() || null,
    // Same rule as fetchShopSettings: only a plain three-letter code is trusted.
    currencyCode: code && /^[A-Z]{3}$/.test(code) ? code : null,
    grantedScopes: granted,
    missingScopes: REQUIRED_SCOPES.filter((r) => !satisfies(r)),
  };
}
