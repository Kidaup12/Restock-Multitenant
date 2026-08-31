import { appCredentials, type QuickBooksAppCredentials } from "./env";

/**
 * QuickBooks Online OAuth 2.0, authorization-code flow.
 *
 * Endpoint constants come from Intuit's OpenID discovery document rather than
 * from prose, so they can be re-checked against a machine-readable source:
 * https://developer.api.intuit.com/.well-known/openid_sandbox_configuration/
 *
 * The authorize and token endpoints are the same for sandbox and production —
 * which company you reach is decided by the realmId and the API host, not by
 * where you sign in. Only the API base differs (see env.ts).
 */

export const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

/**
 * What we ask a shop to grant.
 *
 * Accounting only. The app can be enabled for Payments, and Intuit's own quick
 * start suggests requesting it — but Wezesha decides what to restock and has no
 * business holding permission to move money. `openid`/`profile`/`email` are not
 * requested either: nothing in the product needs the owner's Intuit identity,
 * and the connection is identified by realmId.
 */
export const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";

/** Intuit's token response. `x_refresh_token_expires_in` is their extension —
 *  the OAuth spec has no field for a refresh token's own lifetime. */
type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  x_refresh_token_expires_in?: unknown;
  token_type?: unknown;
};

export type QuickBooksTokens = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  scopes: string;
};

/**
 * A refresh or exchange that failed because the grant itself is dead — a revoked
 * connection, or a refresh token left unused past its lifetime.
 *
 * Separated from a transport failure on purpose: retrying a network blip is
 * right, and retrying this is pointless. Only someone reconnecting fixes it, so
 * the caller pauses the sync rather than looping.
 */
export class QuickBooksAuthError extends Error {
  constructor(
    message: string,
    /** True when Intuit said the grant is invalid, not merely that it failed. */
    readonly unrecoverable: boolean
  ) {
    super(message);
    this.name = "QuickBooksAuthError";
  }
}

/** Where to send the owner's browser to consent and pick their company. */
export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("scope", options.scope ?? ACCOUNTING_SCOPE);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", options.state);
  return url.toString();
}

/** HTTP Basic, which is how Intuit authenticates the token endpoint. */
function basicAuth({ clientId, clientSecret }: QuickBooksAppCredentials): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Intuit documents the refresh token as living about 100 days. It is normally
 * returned as `x_refresh_token_expires_in`, but the value is only used to decide
 * when to stop trying, so a missing field falls back to the documented figure
 * rather than treating the connection as immortal — the failure we care about is
 * believing a dead token is still good.
 */
const REFRESH_TOKEN_FALLBACK_SECONDS = 100 * 24 * 60 * 60;
/** Access tokens are an hour; used only if Intuit omits `expires_in`. */
const ACCESS_TOKEN_FALLBACK_SECONDS = 60 * 60;

function seconds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readTokens(body: TokenResponse, scopes: string, now: Date): QuickBooksTokens {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new QuickBooksAuthError("Intuit returned a token response with no tokens in it", false);
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(
      now.getTime() + seconds(body.expires_in, ACCESS_TOKEN_FALLBACK_SECONDS) * 1000
    ),
    refreshTokenExpiresAt: new Date(
      now.getTime() +
        seconds(body.x_refresh_token_expires_in, REFRESH_TOKEN_FALLBACK_SECONDS) * 1000
    ),
    scopes,
  };
}

async function postToken(
  form: URLSearchParams,
  credentials: QuickBooksAppCredentials,
  scopes: string,
  now: Date
): Promise<QuickBooksTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(credentials),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // `invalid_grant` is Intuit saying the grant is gone — revoked, already
    // used, or expired. Anything else (5xx, a timeout, a throttle) is worth
    // retrying, so only this one is marked unrecoverable.
    const unrecoverable = res.status === 400 && detail.includes("invalid_grant");
    throw new QuickBooksAuthError(
      `QuickBooks token request failed (${res.status})`,
      unrecoverable
    );
  }
  return readTokens((await res.json()) as TokenResponse, scopes, now);
}

/** Step two of the install: the authorization code becomes a token pair. */
export function exchangeCodeForToken(options: {
  code: string;
  redirectUri: string;
  scope?: string;
  credentials?: QuickBooksAppCredentials;
  now?: Date;
}): Promise<QuickBooksTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
  });
  return postToken(
    form,
    options.credentials ?? appCredentials(),
    options.scope ?? ACCOUNTING_SCOPE,
    options.now ?? new Date()
  );
}

/**
 * Renew an expired access token.
 *
 * **Intuit rotates the refresh token on every refresh** and invalidates the one
 * you sent. The returned pair must be persisted together: storing only the new
 * access token leaves a connection that works for an hour and then fails
 * permanently, reporting an auth error that reads exactly like the customer
 * revoking us. Callers write both in a single update.
 */
export function refreshAccessToken(options: {
  refreshToken: string;
  scope?: string;
  credentials?: QuickBooksAppCredentials;
  now?: Date;
}): Promise<QuickBooksTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });
  return postToken(
    form,
    options.credentials ?? appCredentials(),
    options.scope ?? ACCOUNTING_SCOPE,
    options.now ?? new Date()
  );
}

/**
 * Hand the grant back on disconnect. Revoking either token of a pair kills both.
 *
 * Best-effort by design: the local row is cleared whatever happens here, because
 * a workspace that has pressed Disconnect must end up disconnected even if
 * Intuit is unreachable. Returns whether the revoke was accepted so the caller
 * can say so rather than infer it.
 */
export async function revokeToken(options: {
  token: string;
  credentials?: QuickBooksAppCredentials;
}): Promise<boolean> {
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(options.credentials ?? appCredentials()),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token: options.token }),
  });
  return res.ok;
}
