import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTING_SCOPE,
  AUTHORIZE_URL,
  QuickBooksAuthError,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  revokeToken,
} from "../src/oauth";

/**
 * The OAuth pair against a stubbed Intuit. No network, so these run anywhere;
 * the live handshake is proved separately once the app has our redirect URIs.
 */

const credentials = { clientId: "client-abc", clientSecret: "secret-xyz" };
const NOW = new Date("2026-08-27T09:00:00.000Z");

/** Intuit's documented shape, including their non-standard refresh lifetime. */
const tokenBody = (over: Record<string, unknown> = {}) => ({
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  x_refresh_token_expires_in: 8726400,
  token_type: "bearer",
  ...over,
});

function stubFetch(res: { ok: boolean; status?: number; json?: unknown; text?: string }) {
  const spy = vi.fn(async () => ({
    ok: res.ok,
    status: res.status ?? (res.ok ? 200 : 400),
    json: async () => res.json,
    text: async () => res.text ?? "",
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("authorize url", () => {
  it("carries the parameters Intuit needs, and only the accounting scope", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: credentials.clientId,
        redirectUri: "https://example.test/api/quickbooks/callback",
        state: "nonce-1",
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(credentials.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("nonce-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.test/api/quickbooks/callback"
    );
    expect(url.searchParams.get("scope")).toBe(ACCOUNTING_SCOPE);
  });

  it("never asks for payments", () => {
    // An inventory product holding permission to move money is a permission we
    // would have to justify; the default must not drift into requesting it.
    const url = buildAuthorizeUrl({
      clientId: credentials.clientId,
      redirectUri: "https://example.test/cb",
      state: "s",
    });
    expect(url).not.toContain("payment");
  });
});

describe("code exchange", () => {
  it("posts Basic-authenticated form data and reads both tokens", async () => {
    const spy = stubFetch({ ok: true, json: tokenBody() });
    const tokens = await exchangeCodeForToken({
      code: "auth-code",
      redirectUri: "https://example.test/cb",
      credentials,
      now: NOW,
    });

    const [, init] = spy.mock.calls[0]! as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("client-abc:secret-xyz").toString("base64")}`
    );
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code");

    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
    // Expiries are derived from the response, not from a clock the test shares.
    expect(tokens.accessTokenExpiresAt.toISOString()).toBe("2026-08-27T10:00:00.000Z");
    // 8726400s is 101 days to the second — the figure Intuit actually returns.
    expect(tokens.refreshTokenExpiresAt.toISOString()).toBe("2026-12-06T09:00:00.000Z");
  });

  it("refuses a response with no tokens rather than storing blanks", async () => {
    stubFetch({ ok: true, json: { expires_in: 3600 } });
    await expect(
      exchangeCodeForToken({ code: "c", redirectUri: "r", credentials, now: NOW })
    ).rejects.toBeInstanceOf(QuickBooksAuthError);
  });
});

describe("refresh", () => {
  it("returns the ROTATED refresh token, not the one it sent", async () => {
    // The whole point. Intuit invalidates the refresh token it was given and
    // issues a new one; a caller that keeps the old one has a connection that
    // works for an hour and then fails looking like a revocation.
    stubFetch({ ok: true, json: tokenBody({ access_token: "access-2", refresh_token: "refresh-2" }) });
    const tokens = await refreshAccessToken({
      refreshToken: "refresh-1",
      credentials,
      now: NOW,
    });
    expect(tokens.refreshToken).toBe("refresh-2");
    expect(tokens.refreshToken).not.toBe("refresh-1");
    expect(tokens.accessToken).toBe("access-2");
  });

  it("sends the refresh grant", async () => {
    const spy = stubFetch({ ok: true, json: tokenBody() });
    await refreshAccessToken({ refreshToken: "refresh-1", credentials, now: NOW });
    const [, init] = spy.mock.calls[0]! as unknown as [string, RequestInit];
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
  });

  it("marks a dead grant unrecoverable and a server error retryable", async () => {
    // The distinction decides whether the caller pauses the connection or backs
    // off and tries again; conflating them either spams a dead connection or
    // gives up on a blip.
    stubFetch({ ok: false, status: 400, text: '{"error":"invalid_grant"}' });
    await expect(
      refreshAccessToken({ refreshToken: "dead", credentials, now: NOW })
    ).rejects.toMatchObject({ unrecoverable: true });

    stubFetch({ ok: false, status: 503, text: "upstream unavailable" });
    await expect(
      refreshAccessToken({ refreshToken: "fine", credentials, now: NOW })
    ).rejects.toMatchObject({ unrecoverable: false });
  });

  it("falls back to the documented lifetimes when Intuit omits them", async () => {
    stubFetch({ ok: true, json: { access_token: "a", refresh_token: "r" } });
    const tokens = await refreshAccessToken({ refreshToken: "r0", credentials, now: NOW });
    // An hour, and ~100 days — a missing field must not read as "never expires".
    expect(tokens.accessTokenExpiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(tokens.refreshTokenExpiresAt.getTime()).toBe(NOW.getTime() + 100 * 86_400_000);
  });
});

describe("revoke", () => {
  it("reports whether Intuit accepted it", async () => {
    stubFetch({ ok: true, json: {} });
    await expect(revokeToken({ token: "t", credentials })).resolves.toBe(true);
    stubFetch({ ok: false, status: 400, text: "" });
    await expect(revokeToken({ token: "t", credentials })).resolves.toBe(false);
  });
});
