import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

/**
 * Webhook receiver against the real route handler + local db + local redis:
 * HMAC gate, webhookId dedupe, enqueue-on-data-topics, app/uninstalled
 * handling. Skips without a local service connection + REDIS_URL.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const redisUrl = process.env.REDIS_URL;
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl) && Boolean(redisUrl);

const SECRET = "webhook-test-secret";
const SLUG = "webhook-test-tenant";
const SHOP = "webhook-test-store.myshopify.com";
const base = "http://webhook.test";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("base64");
}

async function removeEnqueuedJob(tenantId: string): Promise<void> {
  const { Redis } = await import("ioredis");
  const { createSyncQueue, syncJobId } = await import("@wezesha/queue");
  const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const queue = createSyncQueue(connection);
  await (await queue.getJob(syncJobId({ tenantId, source: "shopify" })))?.remove().catch(() => {});
  await queue.close();
  await connection.quit();
}

function webhookRequest(opts: {
  body: string;
  topic: string;
  webhookId: string;
  shop?: string;
  hmac?: string;
}): Request {
  return new Request(`${base}/api/webhooks/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": opts.hmac ?? sign(opts.body),
      "x-shopify-topic": opts.topic,
      "x-shopify-webhook-id": opts.webhookId,
      "x-shopify-shop-domain": opts.shop ?? SHOP,
    },
    body: opts.body,
  });
}

describe.skipIf(!runnable)("shopify webhook route (real db + redis)", () => {
  let POST: (req: Request) => Promise<Response>;
  let prismaService: typeof import("@wezesha/db").prismaService;
  let tenantId: string;
  const run = Date.now().toString(36);

  beforeAll(async () => {
    process.env.SHOPIFY_API_SECRET = SECRET;
    ({ prismaService } = await import("@wezesha/db"));
    ({ POST } = (await import("../app/api/webhooks/shopify/route")) as unknown as {
      POST: (req: Request) => Promise<Response>;
    });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "Webhook Test", slug: SLUG } });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: { tenantId, shopDomain: SHOP, accessToken: "ciphertext", scopes: "read_products" },
    });
  });

  afterAll(async () => {
    // Clear any job this suite enqueued so the worker suites start clean.
    const { Redis } = await import("ioredis");
    const { createSyncQueue, syncJobId } = await import("@wezesha/queue");
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = createSyncQueue(connection);
    await (await queue.getJob(syncJobId({ tenantId, source: "shopify" })))?.remove().catch(() => {});
    await queue.close();
    await connection.quit();

    await prismaService.webhookEvent.deleteMany({ where: { shopDomain: { contains: "webhook-test" } } });
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("rejects a bad signature outright", async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await POST(webhookRequest({ body, topic: "orders/create", webhookId: `${run}-bad`, hmac: sign("other") }));
    expect(res.status).toBe(401);
    expect(await prismaService.webhookEvent.findUnique({ where: { webhookId: `${run}-bad` } })).toBeNull();
  });

  it("accepts a signed data webhook, records it, and enqueues the tenant sync", async () => {
    const body = JSON.stringify({ id: 42, admin_graphql_api_id: "gid://shopify/Order/42" });
    const res = await POST(webhookRequest({ body, topic: "orders/create", webhookId: `${run}-w1` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const event = await prismaService.webhookEvent.findUnique({ where: { webhookId: `${run}-w1` } });
    expect(event?.topic).toBe("orders/create");
    expect(event?.shopDomain).toBe(SHOP);

    const { Redis } = await import("ioredis");
    const { createSyncQueue, syncJobId } = await import("@wezesha/queue");
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = createSyncQueue(connection);
    const job = await queue.getJob(syncJobId({ tenantId, source: "shopify" }));
    expect(job).toBeTruthy();
    await job!.remove();
    await queue.close();
    await connection.quit();
  });

  it("short-circuits a redelivered webhookId (idempotency by delivery id)", async () => {
    const body = JSON.stringify({ id: 43 });
    expect((await POST(webhookRequest({ body, topic: "products/update", webhookId: `${run}-w2` }))).status).toBe(200);
    const replay = await POST(webhookRequest({ body, topic: "products/update", webhookId: `${run}-w2` }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect(await prismaService.webhookEvent.count({ where: { webhookId: `${run}-w2` } })).toBe(1);
    await removeEnqueuedJob(tenantId); // the first delivery legitimately enqueued
  });

  it("answers 200 for an unknown shop so Shopify stops retrying", async () => {
    const body = JSON.stringify({ id: 44 });
    const res = await POST(
      webhookRequest({ body, topic: "orders/create", webhookId: `${run}-w3`, shop: "webhook-test-unknown.myshopify.com" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });

  it("app/uninstalled marks the connection and persists a Notification", async () => {
    const body = JSON.stringify({ domain: SHOP });
    const res = await POST(webhookRequest({ body, topic: "app/uninstalled", webhookId: `${run}-w4` }));
    expect(res.status).toBe(200);

    const connection = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
    expect(connection?.uninstalledAt).toBeTruthy();

    const notifications = await prismaService.notification.findMany({ where: { tenantId } });
    expect(notifications.some((n) => n.kind === "shopify_uninstalled")).toBe(true);
  });

  it("does not enqueue syncs for an uninstalled connection", async () => {
    const body = JSON.stringify({ id: 45 });
    const res = await POST(webhookRequest({ body, topic: "inventory_levels/update", webhookId: `${run}-w5` }));
    expect(res.status).toBe(200);

    const { Redis } = await import("ioredis");
    const { createSyncQueue, syncJobId } = await import("@wezesha/queue");
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = createSyncQueue(connection);
    expect(await queue.getJob(syncJobId({ tenantId, source: "shopify" }))).toBeUndefined();
    await queue.close();
    await connection.quit();
  });
});
