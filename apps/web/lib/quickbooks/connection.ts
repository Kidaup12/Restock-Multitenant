/**
 * Moved to `@wezesha/quickbooks` so the worker can use it too — the worker
 * cannot import from apps/web, and a second copy of the token rotation would
 * race this one for Intuit's single-use refresh token.
 *
 * Re-exported here so the routes and tests that already point at this path keep
 * working.
 */
export {
  activeAccessToken,
  disconnect,
  recordAuthFailure,
  saveConnection,
  type ActiveToken,
} from "@wezesha/quickbooks";
