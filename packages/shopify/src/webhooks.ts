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
  "ORDERS_CREATE",
  "APP_UNINSTALLED",
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

/* eslint-disable @typescript-eslint/no-explicit-any -- GraphQL edge unwrapping */

/** Subscribe every missing topic to `callbackUrl`. Existing subscriptions for
 *  the same topic+address are left alone, so re-running is a no-op. */
export async function ensureWebhookSubscriptions(client: ShopifyClient, callbackUrl: string): Promise<void> {
  const existing = await client.graphql<any>(
    `query {
      webhookSubscriptions(first: 50) {
        edges { node { topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
      }
    }`
  );
  const active = new Set<string>(
    (existing.webhookSubscriptions?.edges ?? [])
      .filter((e: any) => e.node?.endpoint?.callbackUrl === callbackUrl)
      .map((e: any) => e.node.topic as string)
  );

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
