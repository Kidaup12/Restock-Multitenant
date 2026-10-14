import type { ShopifyClient } from "./client";

/**
 * Webhook subscriptions the sync core depends on. Registered idempotently at
 * the start of every sync run (not in the OAuth callback): the worker has
 * retries and time, the callback should stay a fast redirect.
 */

export const WEBHOOK_TOPICS = [
  "PRODUCTS_UPDATE",
  // A deleted product never comes back in a products pull, so without this the
  // row only drops off the buy list at the next FULL sync.
  "PRODUCTS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
  // A cost edit changes the inventory item, not the product, so PRODUCTS_UPDATE
  // does not fire for it.
  "INVENTORY_ITEMS_UPDATE",
  "ORDERS_CREATE",
  "APP_UNINSTALLED",
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

/** The path our receiver lives at, on whichever host is current. */
const RECEIVER_PATH = "/api/webhooks/shopify";

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- GraphQL edge unwrapping */

/**
 * Subscribe every missing topic to `callbackUrl`, and drop OUR subscriptions
 * that still point at a previous host. Moving the app between hosts used to
 * leave the old subscriptions behind for good, so the store kept sending every
 * event to an address the app no longer runs at. Only subscriptions to our own
 * receiver path are touched; anything else on the store is left alone.
 */
export async function ensureWebhookSubscriptions(client: ShopifyClient, callbackUrl: string): Promise<void> {
  const existing = await client.graphql<any>(
    `query {
      webhookSubscriptions(first: 100) {
        edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
      }
    }`
  );
  const nodes: Array<{ id: string; topic: string; url: string | undefined }> = (
    existing.webhookSubscriptions?.edges ?? []
  ).map((e: any) => ({ id: e.node?.id, topic: e.node?.topic, url: e.node?.endpoint?.callbackUrl }));

  // Housekeeping, so best-effort: a stale subscription that won't delete must
  // not fail the sync that the subscriptions below exist to serve.
  for (const stale of nodes.filter(
    (n) => n.id && n.url && n.url !== callbackUrl && pathOf(n.url) === RECEIVER_PATH
  )) {
    try {
      const result = await client.graphql<any>(
        `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { field message } } }`,
        { id: stale.id }
      );
      const errors = result.webhookSubscriptionDelete?.userErrors ?? [];
      if (errors.length) {
        console.warn(`webhookSubscriptionDelete(${stale.topic}) ${stale.url}: ${errors.map((e: any) => e.message).join("; ")}`);
      }
    } catch (err) {
      console.warn(`webhookSubscriptionDelete(${stale.topic}) ${stale.url} failed`, err);
    }
  }

  const active = new Set(nodes.filter((n) => n.url === callbackUrl).map((n) => n.topic));
  for (const topic of WEBHOOK_TOPICS) {
    if (active.has(topic)) continue;
    const result = await client.graphql<any>(
      `mutation($topic: WebhookSubscriptionTopic!, $url: URL!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) {
          userErrors { field message }
        }
      }`,
      { topic, url: callbackUrl }
    );
    const errors = result.webhookSubscriptionCreate?.userErrors ?? [];
    // "address already taken" style errors mean another process won the race —
    // that's the idempotent outcome, not a failure.
    const fatal = errors.filter((e: any) => !/taken|exists/i.test(e.message ?? ""));
    if (fatal.length) {
      throw new Error(`webhookSubscriptionCreate(${topic}): ${fatal.map((e: any) => e.message).join("; ")}`);
    }
  }
}
