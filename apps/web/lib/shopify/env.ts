/**
 * The app's own public origin. This is OUR domain, not a Shopify credential —
 * it builds the OAuth redirect_uri and the webhook callback URL, both of which
 * point back at this deployment whichever app a shop connects with.
 *
 * The Shopify client id and secret used to live here too. They no longer exist
 * anywhere in the codebase: every workspace supplies its own
 * (ShopifyAppCredential), with no platform-wide app and no env fallback. See
 * lib/shopify/credentials.ts.
 *
 * Read lazily so build-time page collection doesn't demand it.
 */
export function shopifyAppUrl(): string {
  const appUrl = process.env.SHOPIFY_APP_URL?.replace(/\/$/, "");
  if (!appUrl) throw new Error("SHOPIFY_APP_URL must be set.");
  return appUrl;
}
