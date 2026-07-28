import type { ShopifyClient } from "./client";

/**
 * The store's own settings. Only the currency is read today: the app used to
 * render every figure in shillings regardless of where the shop trades, and the
 * store is the authority on that — not a value someone types into a settings
 * page and gets wrong.
 *
 * Read on each sync rather than only at install, so a store already connected
 * picks its currency up without reconnecting.
 */

export type ShopSettings = { currencyCode: string | null };

export async function fetchShopSettings(client: ShopifyClient): Promise<ShopSettings> {
  const data = await client.graphql<{ shop?: { currencyCode?: string | null } }>(
    `query { shop { currencyCode } }`
  );
  const code = data.shop?.currencyCode?.trim().toUpperCase();
  // Only a plain three-letter code is trusted; anything else leaves the stored
  // value alone rather than writing nonsense into every screen.
  return { currencyCode: code && /^[A-Z]{3}$/.test(code) ? code : null };
}
