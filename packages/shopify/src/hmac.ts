import crypto from "node:crypto";

/**
 * Shopify request authentication. Two distinct schemes share the app's client
 * secret:
 *
 *  - Webhooks sign the RAW request body; the signature travels base64-encoded
 *    in X-Shopify-Hmac-Sha256. Verify against the exact bytes received —
 *    any re-serialization of the JSON breaks the digest.
 *  - The OAuth callback signs its own query string; the signature travels
 *    hex-encoded in the `hmac` parameter, computed over the remaining
 *    parameters sorted lexicographically and joined `k=v&k=v`.
 *
 * Both comparisons are constant-time (timingSafeEqual).
 */

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Verify a webhook delivery: HMAC-SHA256 over the raw body, base64. */
export function verifyWebhookHmac(rawBody: string | Buffer, hmacHeader: string, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest();
  let claimed: Buffer;
  try {
    claimed = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  return safeEqual(digest, claimed);
}

/** Verify an OAuth callback query string: HMAC-SHA256 over sorted params, hex. */
export function verifyOAuthHmac(params: URLSearchParams, secret: string): boolean {
  const hmac = params.get("hmac");
  if (!hmac) return false;
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const digest = crypto.createHmac("sha256", secret).update(pairs.join("&")).digest("hex");
  return safeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
}
