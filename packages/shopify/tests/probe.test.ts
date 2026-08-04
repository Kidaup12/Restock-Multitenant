import { describe, expect, it } from "vitest";
import type { ShopifyClient } from "../src/client";
import { ShopifyAuthError } from "../src/client";
import { probeConnection } from "../src/probe";

/**
 * The check that stands between someone pasting a token and the app storing it.
 * What matters is that it answers the two questions a person actually has —
 * "did it work" and "which store did I just connect" — and that a token which is
 * accepted but under-scoped is caught HERE rather than as a sync that quietly
 * reads no stock.
 */

function clientReturning(data: unknown): ShopifyClient {
  return {
    shopDomain: "example-store.myshopify.com",
    graphql: async <T,>() => data as T,
  };
}

const scopes = (...handles: string[]) => handles.map((handle) => ({ handle }));

describe("probeConnection", () => {
  it("reports the store and finds nothing missing when every scope is granted", async () => {
    const probe = await probeConnection(
      clientReturning({
        shop: { name: "Amara Beauty", currencyCode: "KES" },
        currentAppInstallation: {
          accessScopes: scopes("read_products", "read_inventory", "read_orders", "read_locations"),
        },
      })
    );
    expect(probe.shopName).toBe("Amara Beauty");
    expect(probe.currencyCode).toBe("KES");
    expect(probe.missingScopes).toEqual([]);
  });

  it("names exactly the scopes the token does not carry", async () => {
    const probe = await probeConnection(
      clientReturning({
        shop: { name: "Partial Store", currencyCode: "USD" },
        currentAppInstallation: { accessScopes: scopes("read_products", "read_orders") },
      })
    );
    // Naming them is the point: "insufficient permissions" sends someone back to
    // Shopify with nothing to act on.
    expect(probe.missingScopes).toEqual(["read_inventory", "read_locations"]);
  });

  it("accepts read_all_orders in place of read_orders", async () => {
    // A shop that ticked the wider history scope has MORE access, not less, and
    // must not be told it is missing something.
    const probe = await probeConnection(
      clientReturning({
        shop: { name: "Wide History", currencyCode: "KES" },
        currentAppInstallation: {
          accessScopes: scopes("read_products", "read_inventory", "read_all_orders", "read_locations"),
        },
      })
    );
    expect(probe.missingScopes).toEqual([]);
  });

  it("treats a nonsense currency as unknown rather than writing it everywhere", async () => {
    const probe = await probeConnection(
      clientReturning({
        shop: { name: "Odd", currencyCode: "kenyan shillings" },
        currentAppInstallation: { accessScopes: scopes("read_products") },
      })
    );
    expect(probe.currencyCode).toBeNull();
  });

  it("survives a response with no installation block at all", async () => {
    const probe = await probeConnection(clientReturning({ shop: { name: null, currencyCode: null } }));
    expect(probe.grantedScopes).toEqual([]);
    // Everything required is missing, which is the honest answer — not a crash.
    expect(probe.missingScopes).toHaveLength(4);
  });

  it("lets an auth failure through to the caller", async () => {
    const client: ShopifyClient = {
      shopDomain: "example-store.myshopify.com",
      graphql: async () => {
        throw new ShopifyAuthError(401, "example-store.myshopify.com");
      },
    };
    await expect(probeConnection(client)).rejects.toBeInstanceOf(ShopifyAuthError);
  });
});
