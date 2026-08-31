import crypto from "node:crypto";

/** OAuth state-nonce cookie, shared by the install and callback routes. */
export const STATE_COOKIE = "quickbooks_oauth_state";
export const STATE_COOKIE_PATH = "/api/quickbooks";

/** Opaque nonce tying a callback to the install that started it. */
export function generateOAuthState(): string {
  return crypto.randomBytes(24).toString("base64url");
}
