/** Shopify app credentials + public origin, read lazily so build-time page
 *  collection doesn't demand them. Fails loudly at first real use. */
export function shopifyEnv(): { apiKey: string; apiSecret: string; appUrl: string } {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL?.replace(/\/$/, "");
  if (!apiKey || !apiSecret || !appUrl) {
    throw new Error("SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_APP_URL must be set.");
  }
  return { apiKey, apiSecret, appUrl };
}
