import { describe, expect, it, vi } from "vitest";
import { ShopifyGrantError, createTokenCache, mintAdminToken } from "../src/token";

/**
 * Minting short-lived Admin tokens instead of storing one.
 *
 * The bug this replaces: a client-credentials token lives ~24h, we persisted it
 * as if permanent, and every store started answering 403 about a day after it
 * was connected. Shopify calls an expired token "revoked or app uninstalled",
 * which is why it read as a store problem rather than ours.
 */

const CREDS = { clientId: "client-abc", clientSecret: "secret-xyz" };
const SHOP = "demo.myshopify.com";

function grantResponse(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("mintAdminToken", () => {
  it("asks for a client-credentials grant and reads back the token and scopes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          access_token: "shpat_minted",
          scope: "read_products,read_inventory",
          expires_in: 86399,
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const token = await mintAdminToken(SHOP, CREDS, fetchImpl);

    expect(calls[0]!.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    // No redirect, no code, no listing — the whole reason this works for an app
    // whose distribution was never set up.
    expect(calls[0]!.body).toEqual({
      grant_type: "client_credentials",
      client_id: CREDS.clientId,
      client_secret: CREDS.clientSecret,
    });
    expect(token.accessToken).toBe("shpat_minted");
    expect(token.scopes).toEqual(["read_products", "read_inventory"]);
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it("expires the token EARLY, so a long run cannot have it die mid-flight", async () => {
    const token = await mintAdminToken(
      SHOP,
      CREDS,
      grantResponse({ access_token: "t", scope: "", expires_in: 86399 })
    );
    // 86399s minus the safety margin, never the full stated lifetime.
    expect(token.expiresAt).toBeLessThan(Date.now() + 86399 * 1000);
  });

  it("treats a grant with no stated expiry as short-lived, not permanent", async () => {
    // Assuming permanence is precisely what broke; re-minting costs one request.
    const token = await mintAdminToken(SHOP, CREDS, grantResponse({ access_token: "t" }));
    expect(token.expiresAt).toBeLessThan(Date.now() + 86_400_000);
  });

  it("names the store when Shopify rejects the credentials", async () => {
    await expect(
      mintAdminToken(SHOP, CREDS, grantResponse({ error: "invalid_client" }, 401))
    ).rejects.toBeInstanceOf(ShopifyGrantError);
  });

  it("rejects a 200 that carries no token rather than returning undefined", async () => {
    await expect(
      mintAdminToken(SHOP, CREDS, grantResponse({ scope: "read_products" }))
    ).rejects.toBeInstanceOf(ShopifyGrantError);
  });
});

describe("token cache", () => {
  it("mints once and reuses until the token is near expiry", async () => {
    const mint = vi.fn(async () => ({
      accessToken: "t1",
      scopes: [],
      expiresAt: 10_000,
    }));
    let clock = 0;
    const cache = createTokenCache(mint, () => clock);

    expect(await cache.get(SHOP, CREDS)).toBe("t1");
    clock = 9_000;
    expect(await cache.get(SHOP, CREDS)).toBe("t1");
    expect(mint).toHaveBeenCalledTimes(1);

    // Past expiry: a new token, without anyone having to reconnect the store.
    mint.mockResolvedValueOnce({ accessToken: "t2", scopes: [], expiresAt: 20_000 });
    clock = 11_000;
    expect(await cache.get(SHOP, CREDS)).toBe("t2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("keeps shops apart", async () => {
    const mint = vi.fn(async (shop: string) => ({
      accessToken: `token-for-${shop}`,
      scopes: [],
      expiresAt: 10_000,
    }));
    const cache = createTokenCache(mint, () => 0);
    expect(await cache.get("a.myshopify.com", CREDS)).toBe("token-for-a.myshopify.com");
    expect(await cache.get("b.myshopify.com", CREDS)).toBe("token-for-b.myshopify.com");
    expect(cache.size).toBe(2);
  });

  it("re-mints after an invalidate, for a token refused before its stated expiry", async () => {
    let n = 0;
    const mint = vi.fn(async () => ({ accessToken: `t${++n}`, scopes: [], expiresAt: 10_000 }));
    const cache = createTokenCache(mint, () => 0);

    expect(await cache.get(SHOP, CREDS)).toBe("t1");
    cache.invalidate(SHOP);
    expect(await cache.get(SHOP, CREDS)).toBe("t2");
  });
});
