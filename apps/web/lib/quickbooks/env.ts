/**
 * Where Intuit sends the owner back.
 *
 * Built from BETTER_AUTH_URL — this app's own public origin — and never from
 * the incoming request. Behind a proxy the request resolves to the container's
 * own listener, which is how a merchant completing a Shopify connect was once
 * sent to https://localhost:8080. The value here must also match, character for
 * character, a redirect URI registered on the Intuit app: Intuit rejects the
 * exchange otherwise.
 */
export function quickBooksRedirectUri(): string {
  const origin = process.env.BETTER_AUTH_URL?.replace(/\/$/, "");
  if (!origin) {
    throw new Error("BETTER_AUTH_URL must be set (QuickBooks OAuth redirect URI).");
  }
  return `${origin}/api/quickbooks/callback`;
}

/** This app's own origin, for redirects back into the UI. */
export function appOrigin(): string {
  const origin = process.env.BETTER_AUTH_URL?.replace(/\/$/, "");
  if (!origin) throw new Error("BETTER_AUTH_URL must be set.");
  return origin;
}
