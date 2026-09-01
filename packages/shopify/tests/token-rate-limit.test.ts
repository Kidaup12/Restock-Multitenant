import { describe, expect, it, vi } from "vitest";
import { ShopifyRateLimitedError } from "../src/client";
import { ShopifyGrantError, mintAdminToken } from "../src/token";

/**
 * Being told to slow down is not being refused.
 *
 * Every non-OK status used to become a ShopifyGrantError, and the sync counts a
 * grant error as an auth failure — so enough 429s in a row would PAUSE a
 * healthy connection and tell the shop its store had rejected us. Our own retry
 * rate would have produced a message blaming the merchant's Shopify setup.
 */

const CREDS = { clientId: "id", clientSecret: "secret" };

function reply(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => "throttled",
    json: async () => ({}),
  } as unknown as Response;
}

describe("minting a token when Shopify is rate limiting", () => {
  it("raises a rate-limit error, not a grant error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(429));
    const err = await mintAdminToken("shop.myshopify.com", CREDS, fetchImpl as never).catch(
      (e: unknown) => e,
    );

    expect(err, "a 429 counts as an auth failure and pauses the store").toBeInstanceOf(
      ShopifyRateLimitedError,
    );
    expect(err).not.toBeInstanceOf(ShopifyGrantError);
  });

  it("honours Retry-After so the wait matches what Shopify asked for", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(429, { "Retry-After": "3.5" }));
    const err = (await mintAdminToken("shop.myshopify.com", CREDS, fetchImpl as never).catch(
      (e: unknown) => e,
    )) as ShopifyRateLimitedError;

    expect(err.retryAfterMs).toBe(3_500);
  });

  it("falls back to a sane wait when the header is missing or junk", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(429, { "Retry-After": "soon" }));
    const err = (await mintAdminToken("shop.myshopify.com", CREDS, fetchImpl as never).catch(
      (e: unknown) => e,
    )) as ShopifyRateLimitedError;

    expect(err.retryAfterMs).toBe(2_000);
  });

  it("still treats a real refusal as a grant error", async () => {
    // The shop_not_permitted case: a 400 IS the credentials being refused, and
    // must keep counting, or a genuinely broken connection never pauses.
    const fetchImpl = vi.fn().mockResolvedValue(reply(400));
    const err = await mintAdminToken("shop.myshopify.com", CREDS, fetchImpl as never).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ShopifyGrantError);
    expect(err).not.toBeInstanceOf(ShopifyRateLimitedError);
  });
});
