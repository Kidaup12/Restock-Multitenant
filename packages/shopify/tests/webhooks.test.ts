import { describe, expect, it } from "vitest";
import type { ShopifyClient } from "../src/client";
import { WEBHOOK_TOPICS, ensureWebhookSubscriptions } from "../src/webhooks";

const CALLBACK = "https://app.example/api/webhooks/shopify";

/** A client that reports `existing` topics already pointed at CALLBACK and
 *  records every topic the caller then tries to create. */
function clientWith(existing: string[], created: string[], userErrors: Array<{ message: string }> = []) {
  const client: ShopifyClient = {
    shopDomain: "example-store.myshopify.com",
    graphql: async <T,>(query: string, variables?: Record<string, unknown>) => {
      if (query.includes("webhookSubscriptions")) {
        return {
          webhookSubscriptions: {
            edges: existing.map((topic) => ({ node: { topic, endpoint: { callbackUrl: CALLBACK } } })),
          },
        } as T;
      }
      created.push(variables!.topic as string);
      return { webhookSubscriptionCreate: { userErrors } } as T;
    },
  };
  return client;
}

describe("ensureWebhookSubscriptions", () => {
  it("subscribes to product deletes as well as updates", async () => {
    // Deleting a product in the store is invisible to a products pull — it just
    // stops appearing — so the topic has to be registered for the row to react.
    expect(WEBHOOK_TOPICS).toContain("PRODUCTS_DELETE");

    const created: string[] = [];
    await ensureWebhookSubscriptions(clientWith([], created), CALLBACK);
    expect(created).toEqual([...WEBHOOK_TOPICS]);
  });

  it("leaves topics already pointed at the callback alone", async () => {
    const created: string[] = [];
    await ensureWebhookSubscriptions(clientWith(["PRODUCTS_UPDATE", "PRODUCTS_DELETE"], created), CALLBACK);
    expect(created).not.toContain("PRODUCTS_DELETE");
    expect(created).toContain("ORDERS_CREATE");
  });

  it("treats an already-taken address as the idempotent outcome, not a failure", async () => {
    const created: string[] = [];
    await expect(
      ensureWebhookSubscriptions(clientWith([], created, [{ message: "Address for this topic has already been taken" }]), CALLBACK)
    ).resolves.toBeUndefined();
  });
});
