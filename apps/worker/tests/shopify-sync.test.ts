import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { UnrecoverableError, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { SyncJobData } from "@wezesha/queue";
import { decodeEnvelope } from "@wezesha/realtime";
import {
  ShopifyAuthError,
  encryptToken,
  type ShopifyLocationNode,
  type ShopifyOrderNode,
  type ShopifyProductNode,
} from "@wezesha/shopify";

/**
 * The real sync processor against the real local database and Redis, with the
 * Shopify API surface faked at the injection seam. Proves the load-bearing
 * semantics: numeric-core identity, on_hand rollup, processedAt bucketing,
 * idempotent day-set sales writes, per-resource cursors, failure notifications.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "shopify-sync-test";
const SHOP = "sync-test-store.myshopify.com";
const TOKEN = "shpat_sync_test_token";

const products: ShopifyProductNode[] = [
  {
    id: "gid://shopify/Product/101",
    title: "Argan Oil 100ml",
    vendor: "Beauty Co",
    productType: "OILS",
    createdAt: "2025-01-15T08:00:00Z",
    featuredImage: { url: "https://cdn.example/argan.jpg" },
    variants: [
      {
        id: "gid://shopify/ProductVariant/201",
        sku: "ARG-100",
        price: "1200",
        inventoryItem: { id: "gid://shopify/InventoryItem/301", unitCost: { amount: "700" } },
      },
    ],
  },
  {
    id: "gid://shopify/Product/102",
    title: "Shea Butter 250g",
    variants: [{ id: "gid://shopify/ProductVariant/202", sku: "SHEA-250", price: "800" }],
  },
];

const locations: ShopifyLocationNode[] = [
  {
    id: "gid://shopify/Location/9001",
    name: "Main Store",
    isActive: true,
    inventoryLevels: [
      {
        quantities: [
          { name: "available", quantity: 4 },
          { name: "on_hand", quantity: 6 },
        ],
        item: { id: "gid://shopify/InventoryItem/301", variant: { id: "gid://shopify/ProductVariant/201", product: { id: "gid://shopify/Product/101" } } },
      },
    ],
  },
  {
    id: "gid://shopify/Location/9002",
    name: "Warehouse",
    isActive: true,
    inventoryLevels: [
      {
        quantities: [{ name: "on_hand", quantity: 10 }],
        item: { variant: { product: { id: "gid://shopify/Product/101" } } },
      },
      {
        quantities: [{ name: "on_hand", quantity: 3 }],
        item: { variant: { product: { id: "gid://shopify/Product/102" } } },
      },
    ],
  },
];

const orders: ShopifyOrderNode[] = [
  {
    // Back-dated import: sold 2026-05-10, hit the API 2026-07-01.
    id: "gid://shopify/Order/501",
    createdAt: "2026-07-01T09:00:00Z",
    processedAt: "2026-05-10T10:00:00Z",
    lineItems: [
      { quantity: 2, product: { id: "gid://shopify/Product/101" }, originalUnitPriceSet: { shopMoney: { amount: "1200" } } },
    ],
  },
  {
    id: "gid://shopify/Order/502",
    createdAt: "2026-07-02T12:00:00Z",
    lineItems: [
      { quantity: 1, product: { id: "gid://shopify/Product/101" }, originalUnitPriceSet: { shopMoney: { amount: "1200" } } },
      { quantity: 5, product: { id: "gid://shopify/Product/102" }, originalUnitPriceSet: { shopMoney: { amount: "800" } } },
    ],
  },
];

const webhookCalls: string[] = [];
const fakeApi = {
  ensureWebhooks: async (url: string) => {
    webhookCalls.push(url);
  },
  products: async () => products,
  locations: async () => locations,
  orders: async () => orders,
};

function jobStub(tenantId: string): Job<SyncJobData> {
  return {
    data: { tenantId, source: "shopify" },
    opts: { attempts: 6 },
    attemptsMade: 1,
  } as unknown as Job<SyncJobData>;
}

describe.skipIf(!runnable)("shopify sync processor (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let processor: (job: Job<SyncJobData>) => Promise<void>;
  let handleFailure: typeof import("../src/shopify-sync").handleSyncFailure;
  let publisher: Redis;
  let subscriber: Redis;
  let tenantId: string;
  const received: string[] = [];

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    // Import after the key is set — the processor module pulls in the db client.
    ({ prismaService } = await import("@wezesha/db"));
    const mod = await import("../src/shopify-sync");
    handleFailure = mod.handleSyncFailure;

    publisher = new Redis(redisUrl!);
    processor = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => fakeApi,
      appUrl: "https://app.example",
    });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "Sync Test", slug: SLUG } });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: { tenantId, shopDomain: SHOP, accessToken: encryptToken(TOKEN), scopes: "read_products" },
    });

    subscriber = new Redis(redisUrl!);
    await subscriber.subscribe(`tenant:${tenantId}`);
    subscriber.on("message", (_ch, msg) => received.push(msg));
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
    await subscriber.quit();
    await publisher.quit();
  });

  it("runs the full sync: products, inventory, orders", async () => {
    await processor(jobStub(tenantId));

    // Products stored by NUMERIC CORE, never the gid spelling.
    const rows = await prismaService.product.findMany({ where: { tenantId }, orderBy: { sku: "asc" } });
    expect(rows.map((r) => r.shopifyProductId).sort()).toEqual(["101", "102"]);
    const argan = rows.find((r) => r.sku === "ARG-100")!;
    expect(argan.shopifyVariantId).toBe("201");
    expect(argan.priceKes).toBe(1200);
    expect(argan.costKes).toBe(700);
    expect(argan.costSource).toBe("shopify");
    expect(argan.shopifyCreatedAt?.toISOString()).toBe("2025-01-15T08:00:00.000Z");

    // Locations by core; levels carry on_hand (not available); stock rolls up.
    const locs = await prismaService.location.findMany({ where: { tenantId } });
    expect(locs.map((l) => l.shopifyLocationId).sort()).toEqual(["9001", "9002"]);
    const levels = await prismaService.inventoryLevel.findMany({ where: { tenantId } });
    expect(levels).toHaveLength(3);
    expect(levels.find((l) => l.onHand === 6)).toBeTruthy(); // on_hand 6, not available 4
    expect(argan.id).toBeTruthy();
    const arganFresh = await prismaService.product.findFirst({ where: { tenantId, sku: "ARG-100" } });
    expect(arganFresh?.currentStock).toBe(16); // 6 + 10 across locations

    // Sales bucketed by processedAt ?? createdAt.
    const sales = await prismaService.salesHistory.findMany({ where: { tenantId }, orderBy: { date: "asc" } });
    const byKey = new Map(sales.map((s) => [`${s.productId}|${s.date.toISOString().slice(0, 10)}`, s]));
    expect(byKey.get(`${argan.id}|2026-05-10`)?.quantity).toBe(2); // processedAt day, NOT createdAt
    expect(byKey.get(`${argan.id}|2026-07-02`)?.quantity).toBe(1);
    const shea = rows.find((r) => r.sku === "SHEA-250")!;
    expect(byKey.get(`${shea.id}|2026-07-02`)?.revenueKes).toBe(4000);

    // Cursors advanced per resource.
    const cursors = await prismaService.ingestCursor.findMany({ where: { tenantId, source: "shopify" } });
    expect(cursors.map((c) => c.resource).sort()).toEqual(["inventory", "orders", "products"]);

    // Webhooks registered against the app origin.
    expect(webhookCalls).toContain("https://app.example/api/webhooks/shopify");
  });

  it("re-running is idempotent: day-set writes never double-count", async () => {
    await processor(jobStub(tenantId));
    const argan = await prismaService.product.findFirst({ where: { tenantId, sku: "ARG-100" } });
    const sales = await prismaService.salesHistory.findMany({
      where: { tenantId, productId: argan!.id },
      orderBy: { date: "asc" },
    });
    expect(sales.map((s) => s.quantity)).toEqual([2, 1]); // unchanged, not 4/2
  });

  it("publishes progress per phase and a done event", async () => {
    // Pub/sub delivery is async — wait for both runs' events (2 × 3 progress + 2 × done).
    const deadline = Date.now() + 10_000;
    while (received.length < 8 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const envelopes = received.map((m) => decodeEnvelope(m)).filter((e) => e !== null);
    const types = envelopes.map((e) => e!.type);
    expect(types.filter((t) => t === "sync.done").length).toBeGreaterThanOrEqual(2);
    const phases = envelopes
      .filter((e) => e!.type === "sync.progress")
      .map((e) => (e!.data as { phase: string }).phase);
    expect(phases.slice(0, 3)).toEqual(["products", "inventory", "orders"]);
  });

  it("fails unrecoverably when the connection is missing or uninstalled", async () => {
    await prismaService.shopifyConnection.updateMany({
      where: { tenantId },
      data: { uninstalledAt: new Date() },
    });
    await expect(processor(jobStub(tenantId))).rejects.toBeInstanceOf(UnrecoverableError);
    await prismaService.shopifyConnection.updateMany({ where: { tenantId }, data: { uninstalledAt: null } });
  });

  it("maps a Shopify auth failure to an unrecoverable job error", async () => {
    const authFailApi = { ...fakeApi, products: async () => Promise.reject(new ShopifyAuthError(401, SHOP)) };
    const mod = await import("../src/shopify-sync");
    const failing = mod.createShopifySyncProcessor({ publisher, makeApi: () => authFailApi, appUrl: "https://app.example" });
    await expect(failing(jobStub(tenantId))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("final failure persists a reconnect Notification for the bell", async () => {
    // The processor re-throws auth failures as UnrecoverableError — the hook
    // sees the wrapped error, exactly as BullMQ's failed event delivers it.
    const wrapped = new UnrecoverableError(new ShopifyAuthError(401, SHOP).message);
    await handleFailure(jobStub(tenantId), wrapped, publisher);
    const notifications = await prismaService.notification.findMany({ where: { tenantId } });
    expect(notifications.some((n) => n.kind === "shopify_reconnect" && n.readAt === null)).toBe(true);
  });

  it("retry-pending failures stay silent (no notification spam)", async () => {
    const before = await prismaService.notification.count({ where: { tenantId } });
    const job = { ...jobStub(tenantId), attemptsMade: 2, opts: { attempts: 6 } } as unknown as Job<SyncJobData>;
    await handleFailure(job, new Error("transient"), publisher);
    expect(await prismaService.notification.count({ where: { tenantId } })).toBe(before);
  });

  it("final failures email the alert contact once per incident; a successful sync re-arms", async () => {
    const incident = await import("../src/incident");
    await prismaService.tenantConfig.create({
      data: { tenantId, alertEmail: "sync-alerts@example.test" },
    });
    await incident.clearIncident(publisher, tenantId, "shopify");

    const sent: Array<{ to: string; subject: string }> = [];
    const send = async (message: { to: string; subject: string; text: string }) => {
      sent.push({ to: message.to, subject: message.subject });
    };

    const boom = new UnrecoverableError("sync blew up");
    await handleFailure(jobStub(tenantId), boom, publisher, { send });
    await handleFailure(jobStub(tenantId), boom, publisher, { send });
    await handleFailure(jobStub(tenantId), boom, publisher, { send });
    expect(sent).toHaveLength(1); // one incident, one email
    expect(sent[0]!.to).toBe("sync-alerts@example.test");

    // Recovery: a clean run clears the latch...
    await processor(jobStub(tenantId));
    // ...so the next incident emails again.
    await handleFailure(jobStub(tenantId), boom, publisher, { send });
    expect(sent).toHaveLength(2);

    await incident.clearIncident(publisher, tenantId, "shopify");
  });
});
