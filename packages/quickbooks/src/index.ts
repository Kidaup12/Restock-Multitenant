export {
  ACCOUNTING_SCOPE,
  AUTHORIZE_URL,
  REVOKE_URL,
  TOKEN_URL,
  QuickBooksAuthError,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  revokeToken,
  type QuickBooksTokens,
} from "./oauth";

export {
  apiBaseUrl,
  appCredentials,
  quickBooksEnvironment,
  type QuickBooksAppCredentials,
  type QuickBooksEnvironment,
} from "./env";

/** Token encryption is shared with the Shopify connector — one implementation,
 *  one key (TOKEN_ENCRYPTION_KEY), so a connector cannot quietly grow a weaker
 *  one of its own. */
export { decryptToken, encryptToken } from "@wezesha/db/crypto";

export {
  fetchPurchaseOrders,
  QuickBooksApiError,
  type QuickBooksPurchaseOrder,
} from "./purchase-orders";

export {
  matchPurchaseOrders,
  type LocalPurchaseOrder,
  type MatchOptions,
  type MatchResult,
  type QuickBooksMatch,
  type QuickBooksSuggestion,
} from "./match";

export {
  activeAccessToken,
  disconnect,
  recordAuthFailure,
  saveConnection,
  type ActiveToken,
} from "./connection";

export { reconcilePurchaseOrders, type ReconcileResult } from "./reconcile";
