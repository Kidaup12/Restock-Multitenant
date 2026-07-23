import { describe, expect, it } from "vitest";
import {
  REQUIRED_SCOPES,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generateOAuthState,
  isValidShopDomain,
} from "../src/oauth";

describe("isValidShopDomain", () => {
  it("accepts plain *.myshopify.com domains", () => {
    expect(isValidShopDomain("example-store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("a1.myshopify.com")).toBe(true);
  });

  it("rejects anything else (open-redirect / SSRF guard)", () => {
    expect(isValidShopDomain("example.com")).toBe(false);
    expect(isValidShopDomain("evil.com/x.myshopify.com")).toBe(false);
    expect(isValidShopDomain("shop.myshopify.com.evil.com")).toBe(false);
    expect(isValidShopDomain("-bad.myshopify.com")).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
  });
});

describe("generateOAuthState", () => {
  it("is unguessable-length hex and unique per call", () => {
    const a = generateOAuthState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(generateOAuthState()).not.toBe(a);
  });
});

describe("buildAuthorizeUrl", () => {
  it("targets the shop's authorize endpoint with the sync-core scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        shop: "example-store.myshopify.com",
        clientId: "client-id",
        redirectUri: "https://app.example/api/shopify/callback",
        state: "nonce",
      })
    );
    expect(url.origin).toBe("https://example-store.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe(REQUIRED_SCOPES.join(","));
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/shopify/callback");
    expect(url.searchParams.get("state")).toBe("nonce");
  });
});

describe("exchangeCodeForToken", () => {
  it("posts the code and returns the offline token + scopes", async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_products,read_orders" }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await exchangeCodeForToken({
      shop: "example-store.myshopify.com",
      clientId: "id",
      clientSecret: "secret",
      code: "code123",
      fetchImpl,
    });
    expect(result).toEqual({ accessToken: "shpat_x", scopes: "read_products,read_orders" });
    expect(captured?.url).toBe("https://example-store.myshopify.com/admin/oauth/access_token");
    expect(captured?.body).toEqual({ client_id: "id", client_secret: "secret", code: "code123" });
  });

  it("throws on a non-200 exchange", async () => {
    const fetchImpl = (async () => new Response("denied", { status: 400 })) as typeof fetch;
    await expect(
      exchangeCodeForToken({
        shop: "example-store.myshopify.com",
        clientId: "id",
        clientSecret: "secret",
        code: "bad",
        fetchImpl,
      })
    ).rejects.toThrow(/token exchange failed \(400\)/);
  });
});
