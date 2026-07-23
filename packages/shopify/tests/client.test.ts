import { describe, expect, it } from "vitest";
import {
  ShopifyAuthError,
  ShopifyRateLimitedError,
  createShopifyClient,
} from "../src/client";

function clientWith(responses: Response[], capture?: Array<{ url: string; init?: RequestInit }>) {
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.push({ url: String(url), init });
    const res = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return res.clone();
  }) as typeof fetch;
  return createShopifyClient({
    shopDomain: "example-store.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl,
  });
}

describe("createShopifyClient", () => {
  it("posts to the shop's versioned GraphQL endpoint with the token header", async () => {
    const capture: Array<{ url: string; init?: RequestInit }> = [];
    const client = clientWith([new Response(JSON.stringify({ data: { ok: true } }))], capture);
    const data = await client.graphql<{ ok: boolean }>("query { ok }");
    expect(data).toEqual({ ok: true });
    expect(capture[0]!.url).toMatch(
      /^https:\/\/example-store\.myshopify\.com\/admin\/api\/[0-9-]+\/graphql\.json$/
    );
    const headers = capture[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe("shpat_x");
  });

  it("HTTP 429 → ShopifyRateLimitedError honoring Retry-After seconds", async () => {
    const client = clientWith([
      new Response("slow down", { status: 429, headers: { "Retry-After": "7.0" } }),
    ]);
    const err = await client.graphql("query { ok }").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyRateLimitedError);
    expect((err as ShopifyRateLimitedError).retryAfterMs).toBe(7000);
  });

  it("HTTP 429 without Retry-After → default backoff hint", async () => {
    const client = clientWith([new Response("slow down", { status: 429 })]);
    const err = await client.graphql("query { ok }").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyRateLimitedError);
    expect((err as ShopifyRateLimitedError).retryAfterMs).toBe(2000);
  });

  it("GraphQL THROTTLED → ShopifyRateLimitedError with cost-derived delay", async () => {
    const body = {
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: {
        cost: {
          requestedQueryCost: 500,
          throttleStatus: { currentlyAvailable: 100, restoreRate: 50 },
        },
      },
    };
    const client = clientWith([new Response(JSON.stringify(body), { status: 200 })]);
    const err = await client.graphql("query { big }").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyRateLimitedError);
    // (500 - 100) / 50 per second = 8s
    expect((err as ShopifyRateLimitedError).retryAfterMs).toBe(8000);
  });

  it("401 → ShopifyAuthError (no retry — reconnect is the fix)", async () => {
    const client = clientWith([new Response("unauthorized", { status: 401 })]);
    await expect(client.graphql("query { ok }")).rejects.toBeInstanceOf(ShopifyAuthError);
  });

  it("surfaces non-throttle GraphQL errors as plain errors", async () => {
    const client = clientWith([
      new Response(JSON.stringify({ errors: [{ message: "Field 'nope' doesn't exist" }] })),
    ]);
    await expect(client.graphql("query { nope }")).rejects.toThrow(/Field 'nope'/);
  });
});
