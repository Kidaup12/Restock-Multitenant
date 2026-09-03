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
const DELETE_SLUG = "webhook-test-delete-tenant";
const DELETE_SHOP = "webhook-test-delete-store.myshopify.com";
const OTHER_SLUG = "webhook-test-other-tenant";
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
    // The signing secret is per workspace now, so it is stored against the
    // tenant rather than read from the environment.
    process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    const { encryptToken } = await import("@wezesha/shopify");
    ({ POST } = (await import("../app/api/webhooks/shopify/route")) as unknown as {
      POST: (req: Request) => Promise<Response>;
    });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "Webhook Test", slug: SLUG } });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: { tenantId, shopDomain: SHOP, accessToken: "ciphertext", scopes: "read_products" },
    });
    await prismaService.shopifyAppCredential.create({
      data: { tenantId, clientId: "client-webhook-test", apiSecret: encryptToken(SECRET) },
    });
    // The figure every db-backed hook in this suite family uses: it imports the
    // db package, opens a Redis connection and writes four rows.
    //
    // It was raised here to chase timeouts that were never slowness — REDIS_URL
    // had been exported pointing at 6379 while the container listens on 6380,
    // so the connection had nowhere to go and no timeout would have saved it.
    // Kept for consistency with its siblings, not as a fix.
  }, 60_000);

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

  it("an unknown shop is indistinguishable from a forged signature", async () => {
    // Signing secrets are per workspace, so a shop we do not know has no key to
    // check against and CANNOT be authenticated. The old behaviour — 200
    // "ignored", so Shopify would stop retrying — is only possible when one
    // platform secret verifies every delivery, which is exactly the shared-app
    // arrangement that stopped a client connecting its own store.
    //
    // Answering 200 to an unverified request would tell any unauthenticated
    // caller which stores are connected here, one guess at a time. Both cases
    // therefore return the same 401 with the same body.
    const body = JSON.stringify({ id: 44 });
    const unknown = await POST(
      webhookRequest({ body, topic: "orders/create", webhookId: `${run}-w3`, shop: "webhook-test-unknown.myshopify.com" })
    );
    const forged = await POST(
      webhookRequest({ body, topic: "orders/create", webhookId: `${run}-w3b`, hmac: "not-a-signature" })
    );
    expect(unknown.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(await unknown.json()).toEqual(await forged.json());
  });

  it("refuses a malformed shop domain without touching the database", async () => {
    const res = await POST(
      webhookRequest({ body: "{}", topic: "orders/create", webhookId: `${run}-w3c`, shop: "not a domain" })
    );
    expect(res.status).toBe(401);
    // Nothing is recorded for a request that never authenticated.
    expect(await prismaService.webhookEvent.count({ where: { webhookId: `${run}-w3c` } })).toBe(0);
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

/**
 * products/delete is the one topic handled inline: a deleted product never
 * comes back in a products pull, so the receiver stamps missingFromShopifyAt
 * itself. Its own tenants keep the connection installed and the catalogue
 * independent of the suite above.
 */
describe.skipIf(!runnable)("shopify webhook products/delete (real db)", () => {
  let POST: (req: Request) => Promise<Response>;
  let prismaService: typeof import("@wezesha/db").prismaService;
  let tenantId: string;
  let otherTenantId: string;
  const run = Date.now().toString(36);

  /** Two sibling variants of one product, plus an unrelated product. */
  async function seedCatalogue(ownerId: string, prefix: string): Promise<void> {
    await prismaService.product.createMany({
      data: [
        { tenantId: ownerId, sku: `${prefix}-A`, title: "Shade 01", shopifyProductId: "9001", shopifyVariantId: `${prefix}-v1` },
        { tenantId: ownerId, sku: `${prefix}-B`, title: "Shade 02", shopifyProductId: "9001", shopifyVariantId: `${prefix}-v2` },
        { tenantId: ownerId, sku: `${prefix}-C`, title: "Toner", shopifyProductId: "9002", shopifyVariantId: `${prefix}-v3` },
      ],
    });
  }

  function skuState(ownerId: string, sku: string): Promise<{ missingFromShopifyAt: Date | null } | null> {
    return prismaService.product.findFirst({
      where: { tenantId: ownerId, sku },
      select: { missingFromShopifyAt: true },
    });
  }

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    ({ POST } = (await import("../app/api/webhooks/shopify/route")) as unknown as {
      POST: (req: Request) => Promise<Response>;
    });

    await prismaService.tenant.deleteMany({ where: { slug: { in: [DELETE_SLUG, OTHER_SLUG] } } });
    const owner = await prismaService.tenant.create({ data: { name: "Delete Test", slug: DELETE_SLUG } });
    tenantId = owner.id;
    const other = await prismaService.tenant.create({ data: { name: "Other Shop", slug: OTHER_SLUG } });
    otherTenantId = other.id;

    await prismaService.shopifyConnection.create({
      data: { tenantId, shopDomain: DELETE_SHOP, accessToken: "ciphertext", scopes: "read_products" },
    });
    const { encryptToken } = await import("@wezesha/shopify");
    await prismaService.shopifyAppCredential.create({
      data: { tenantId, clientId: "client-delete-test", apiSecret: encryptToken(SECRET) },
    });
    await seedCatalogue(tenantId, "DEL");
    await seedCatalogue(otherTenantId, "OTH");
  });

  afterAll(async () => {
    await prismaService.webhookEvent.deleteMany({ where: { shopDomain: { contains: "webhook-test" } } });
    await prismaService.tenant.deleteMany({ where: { slug: { in: [DELETE_SLUG, OTHER_SLUG] } } });
    await prismaService.$disconnect();
  });

  it("stamps every sibling variant of the deleted product and nobody else's", async () => {
    const body = JSON.stringify({ id: 9001 });
    const res = await POST(
      webhookRequest({ body, topic: "products/delete", webhookId: `${run}-d1`, shop: DELETE_SHOP })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect((await skuState(tenantId, "DEL-A"))?.missingFromShopifyAt).toBeTruthy();
    expect((await skuState(tenantId, "DEL-B"))?.missingFromShopifyAt).toBeTruthy();
    // Another product of the same store, and the same product id under another
    // tenant, are untouched — the update is scoped to the resolved tenant.
    expect((await skuState(tenantId, "DEL-C"))?.missingFromShopifyAt).toBeNull();
    expect((await skuState(otherTenantId, "OTH-A"))?.missingFromShopifyAt).toBeNull();
    expect((await skuState(otherTenantId, "OTH-B"))?.missingFromShopifyAt).toBeNull();
  });

  it("keeps the first 'gone since' date when the delete is re-sent", async () => {
    const first = (await skuState(tenantId, "DEL-A"))?.missingFromShopifyAt;
    expect(first).toBeTruthy();

    const body = JSON.stringify({ id: 9001 });
    const res = await POST(
      webhookRequest({ body, topic: "products/delete", webhookId: `${run}-d2`, shop: DELETE_SHOP })
    );
    expect(res.status).toBe(200);
    expect((await skuState(tenantId, "DEL-A"))?.missingFromShopifyAt).toEqual(first);
  });

  it("stops changing the catalogue once the store has been disconnected", async () => {
    // Disconnect stamps uninstalledAt locally; it does not unsubscribe the
    // store's webhooks, so deliveries keep arriving. They must not still be
    // able to mark this workspace's products missing — "disconnected" has to
    // mean the store no longer changes anything here.
    await prismaService.shopifyConnection.updateMany({
      where: { tenantId },
      data: { uninstalledAt: new Date() },
    });
    try {
      const before = (await skuState(tenantId, "DEL-C"))?.missingFromShopifyAt ?? null;
      const res = await POST(
        webhookRequest({
          body: JSON.stringify({ id: 9002 }),
          topic: "products/delete",
          webhookId: `${run}-disc`,
          shop: DELETE_SHOP,
        })
      );
      // 200 so Shopify stops retrying — there is nothing to deliver here.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
      expect((await skuState(tenantId, "DEL-C"))?.missingFromShopifyAt ?? null).toEqual(before);
    } finally {
      await prismaService.shopifyConnection.updateMany({
        where: { tenantId },
        data: { uninstalledAt: null },
      });
    }
  });

  it("matches the stored core id whether the payload sends a gid or a bare number", async () => {
    const body = JSON.stringify({ id: "gid://shopify/Product/9002" });
    const res = await POST(
      webhookRequest({ body, topic: "products/delete", webhookId: `${run}-d3`, shop: DELETE_SHOP })
    );
    expect(res.status).toBe(200);
    expect((await skuState(tenantId, "DEL-C"))?.missingFromShopifyAt).toBeTruthy();
    expect((await skuState(otherTenantId, "OTH-C"))?.missingFromShopifyAt).toBeNull();
  });

  it("ignores a payload with no usable id rather than inviting endless retries", async () => {
    const body = JSON.stringify({ title: "no id here" });
    const res = await POST(
      webhookRequest({ body, topic: "products/delete", webhookId: `${run}-d4`, shop: DELETE_SHOP })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });

    const malformed = await POST(
      webhookRequest({ body: "not json", topic: "products/delete", webhookId: `${run}-d5`, shop: DELETE_SHOP })
    );
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toEqual({ ok: true, ignored: true });
  });

  it("short-circuits a redelivered delete before it reaches the catalogue", async () => {
    await prismaService.product.updateMany({
      where: { tenantId, sku: { in: ["DEL-A", "DEL-B"] } },
      data: { missingFromShopifyAt: null },
    });
    const body = JSON.stringify({ id: 9001 });
    const replay = await POST(
      webhookRequest({ body, topic: "products/delete", webhookId: `${run}-d1`, shop: DELETE_SHOP })
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect((await skuState(tenantId, "DEL-A"))?.missingFromShopifyAt).toBeNull();
  });

  it("leaves the catalogue alone for an unrelated topic", async () => {
    const body = JSON.stringify({ id: 9002 });
    const res = await POST(
      webhookRequest({ body, topic: "products/update", webhookId: `${run}-d6`, shop: DELETE_SHOP })
    );
    expect(res.status).toBe(200);
    expect((await skuState(tenantId, "DEL-A"))?.missingFromShopifyAt).toBeNull();
    await removeEnqueuedJob(tenantId); // products/update legitimately enqueues
  });
});
