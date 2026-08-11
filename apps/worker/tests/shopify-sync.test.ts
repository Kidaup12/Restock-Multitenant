import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
        title: "Default Title",
        price: "1200",
        inventoryItem: { id: "gid://shopify/InventoryItem/301", unitCost: { amount: "700" } },
      },
    ],
  },
  {
    id: "gid://shopify/Product/102",
    title: "Shea Butter 250g",
    variants: [
      { id: "gid://shopify/ProductVariant/202", sku: "SHEA-250", title: "Default Title", price: "800" },
    ],
  },
  {
    // A live store carries one of these: several denominations, no SKU on any of
    // them, and no unit cost. It is issued on sale, not stocked, so it must not
    // reach the catalogue.
    id: "gid://shopify/Product/103",
    title: "Gift Card",
    isGiftCard: true,
    variants: [
      { id: "gid://shopify/ProductVariant/203", sku: null, price: "10" },
      { id: "gid://shopify/ProductVariant/204", sku: null, price: "100" },
    ],
  },
];

// Three roles: a selling branch, a holding warehouse, and an en-route bucket.
// Only the branch's on_hand is sellable; the warehouse holds; en-route feeds
// onOrder. Names are unclassified, so the sync must guess each role.
const locations: ShopifyLocationNode[] = [
  {
    id: "gid://shopify/Location/9001",
    name: "Main Store", // guesses → branch (Sells)
    isActive: true,
    inventoryLevels: [
      {
        quantities: [
          { name: "available", quantity: 4 },
          { name: "on_hand", quantity: 6 },
          { name: "incoming", quantity: 5 },
        ],
        item: { id: "gid://shopify/InventoryItem/301", variant: { id: "gid://shopify/ProductVariant/201", product: { id: "gid://shopify/Product/101" } } },
      },
    ],
  },
  {
    id: "gid://shopify/Location/9002",
    name: "Warehouse", // guesses → warehouse (Holds)
    isActive: true,
    inventoryLevels: [
      // available == on_hand here and below: nothing is committed at these
      // locations, so switching the rollup to available must be provably inert.
      {
        quantities: [
          { name: "available", quantity: 10 },
          { name: "on_hand", quantity: 10 },
        ],
        item: { variant: { id: "gid://shopify/ProductVariant/201", product: { id: "gid://shopify/Product/101" } } },
      },
      {
        quantities: [
          { name: "available", quantity: 3 },
          { name: "on_hand", quantity: 3 },
        ],
        item: { variant: { id: "gid://shopify/ProductVariant/202", product: { id: "gid://shopify/Product/102" } } },
      },
    ],
  },
  {
    id: "gid://shopify/Location/9003",
    name: "INCOMING (QB) ENROUTE ORDERS", // guesses → enroute (En-route)
    isActive: true,
    inventoryLevels: [
      {
        quantities: [
          { name: "available", quantity: 20 },
          { name: "on_hand", quantity: 20 },
        ],
        item: { variant: { id: "gid://shopify/ProductVariant/201", product: { id: "gid://shopify/Product/101" } } },
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
    // Fulfilled from Main Store — attributes this day's sales to that branch.
    fulfillments: [{ location: { id: "gid://shopify/Location/9001" } }],
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
  // The store trades in dollars — the workspace should end up saying so.
  shopSettings: async () => ({ currencyCode: "USD" }),
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
      data: { tenantId, shopDomain: SHOP, accessToken: encryptToken(TOKEN), scopes: "read_products", authMode: "token" },
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

    // Products stored by NUMERIC CORE, never the gid spelling. 103 is the gift
    // card and is deliberately absent — nothing to reorder, no cost to track.
    const rows = await prismaService.product.findMany({ where: { tenantId }, orderBy: { sku: "asc" } });
    expect(rows.map((r) => r.shopifyProductId).sort()).toEqual(["101", "102"]);
    expect(rows.every((r) => r.title !== "Gift Card")).toBe(true);
    const argan = rows.find((r) => r.sku === "ARG-100")!;
    expect(argan.shopifyVariantId).toBe("201");
    expect(argan.priceKes).toBe(1200);
    expect(argan.costKes).toBe(700);
    expect(argan.costSource).toBe("shopify");
    expect(argan.shopifyCreatedAt?.toISOString()).toBe("2025-01-15T08:00:00.000Z");
    // Shopify's placeholder name for an option-less product's only variant never
    // reaches the row.
    expect(argan.variantTitle).toBeNull();

    // Locations by core; each gets a guessed, assumed role (never confirmed here).
    const locs = await prismaService.location.findMany({ where: { tenantId } });
    expect(locs.map((l) => l.shopifyLocationId).sort()).toEqual(["9001", "9002", "9003"]);
    const byCore = new Map(locs.map((l) => [l.shopifyLocationId, l]));
    expect(byCore.get("9001")).toMatchObject({ locationType: "branch", roleStatus: "assumed" });
    expect(byCore.get("9002")).toMatchObject({ locationType: "warehouse", roleStatus: "assumed" });
    expect(byCore.get("9003")).toMatchObject({ locationType: "enroute", roleStatus: "assumed" });

    // Levels carry BOTH quantities: on_hand is what is physically there,
    // available is what can be sold once committed units are set aside. The
    // Main Store has 6 on the shelf with 2 already spoken for.
    const levels = await prismaService.inventoryLevel.findMany({ where: { tenantId } });
    expect(levels).toHaveLength(4);
    const mainStoreArgan = levels.find((l) => l.locationId === byCore.get("9001")!.id && l.onHand === 6);
    expect(mainStoreArgan?.available).toBe(4);
    expect(mainStoreArgan?.incoming).toBe(5); // "incoming" quantity stored per level
    expect(argan.id).toBeTruthy();

    // Role-correct rollup: currentStock is SELLS-only and counts what can
    // actually be SOLD — the Main Store's available 4, not its on-hand 6. The
    // two units already committed to customer orders cannot be sold twice, and
    // counting them is what made the buy list order short. The warehouse's 10
    // holds (excluded). On-order is BOTH in-transit signals — the en-route
    // location's 20 on-hand, plus the 5 Shopify reports as incoming at the Main
    // Store, which is where a transfer or purchase order actually lands.
    const arganFresh = await prismaService.product.findFirst({ where: { tenantId, sku: "ARG-100" } });
    expect(arganFresh?.currentStock).toBe(4);
    expect(arganFresh?.onOrder).toBe(25);
    // Shea only sits in the warehouse — nothing sellable.
    const sheaFresh = await prismaService.product.findFirst({ where: { tenantId, sku: "SHEA-250" } });
    expect(sheaFresh?.currentStock).toBe(0);

    // Sales bucketed by processedAt ?? createdAt, attributed to the fulfilment branch.
    const sales = await prismaService.salesHistory.findMany({ where: { tenantId }, orderBy: { date: "asc" } });
    const byKey = new Map(sales.map((s) => [`${s.productId}|${s.date.toISOString().slice(0, 10)}`, s]));
    expect(byKey.get(`${argan.id}|2026-05-10`)?.quantity).toBe(2); // processedAt day, NOT createdAt
    expect(byKey.get(`${argan.id}|2026-05-10`)?.locationId).toBeNull(); // no fulfilment → unattributed
    expect(byKey.get(`${argan.id}|2026-07-02`)?.quantity).toBe(1);
    expect(byKey.get(`${argan.id}|2026-07-02`)?.locationId).toBe(byCore.get("9001")!.id); // shipped from Main Store
    const shea = rows.find((r) => r.sku === "SHEA-250")!;
    expect(byKey.get(`${shea.id}|2026-07-02`)?.revenueKes).toBe(4000);

    // Cursors advanced per resource.
    const cursors = await prismaService.ingestCursor.findMany({ where: { tenantId, source: "shopify" } });
    expect(cursors.map((c) => c.resource).sort()).toEqual(["inventory", "orders", "products"]);

    // Webhooks registered against the app origin.
    expect(webhookCalls).toContain("https://app.example/api/webhooks/shopify");

    // The store's own currency wins: the workspace was created with the KES
    // default and the store trades in dollars.
    const tenantAfter = await prismaService.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantAfter?.currency).toBe("USD");
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

  it("publishes both edges of every phase, and a done event", async () => {
    // Pub/sub delivery is async — wait for both runs' events. Each run emits
    // started + running + finished per phase, then done.
    const deadline = Date.now() + 10_000;
    while (received.length < 20 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const envelopes = received.map((m) => decodeEnvelope(m)).filter((e) => e !== null);
    const types = envelopes.map((e) => e!.type);
    expect(types.filter((t) => t === "sync.done").length).toBeGreaterThanOrEqual(2);

    const progress = envelopes
      .filter((e) => e!.type === "sync.progress")
      .map((e) => e!.data as { phase: string; state?: string; done: number; total: number; items?: number; itemsTotal?: number; runId?: string });

    // A phase announces itself before it starts work — that is what turns the
    // long opening fetch from silence into a visible "fetching products".
    expect(progress.slice(0, 9).map((p) => [p.phase, p.state])).toEqual([
      ["products", "started"],
      ["products", "running"],
      ["products", "finished"],
      ["inventory", "started"],
      ["inventory", "running"],
      ["inventory", "finished"],
      ["orders", "started"],
      ["orders", "running"],
      ["orders", "finished"],
    ]);

    // The legacy contract is pinned: done/total on the finishing edge is exactly
    // what subscribers written before the widening already read.
    expect(
      progress.slice(0, 9).filter((p) => p.state === "finished").map((p) => [p.done, p.total])
    ).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);

    // Intra-phase counts reach the UI: three product nodes, three locations,
    // three sales day-sets in the fixture.
    const totals = progress
      .slice(0, 9)
      .filter((p) => p.state === "running")
      .map((p) => p.itemsTotal);
    expect(totals).toEqual([3, 3, 3]);
    expect(progress[0]!.runId).toBeTruthy();
  });

  it("records the run, its phase counts, and closes it ok", async () => {
    const runs = await prismaService.syncRun.findMany({
      where: { tenantId, source: "shopify" },
      orderBy: { startedAt: "asc" },
    });
    expect(runs.length).toBeGreaterThanOrEqual(2); // one per processor call above
    const run = runs[runs.length - 1]!;
    expect(run.status).toBe("ok");
    expect(run.finishedAt).not.toBeNull();
    expect(run.phaseTotal).toBe(3);
    expect(run.attempt).toBe(2); // jobStub reports one attempt already made
    expect(run.counts).toMatchObject({
      products: { written: 2, failed: 0 },
      inventory: { locations: 3, levels: 4 },
      orders: { salesDays: 3 },
    });
  });

  it("a failed run closes its row with the error, and a retry opens a new one", async () => {
    const before = await prismaService.syncRun.count({ where: { tenantId } });
    const authFailApi = { ...fakeApi, products: async () => Promise.reject(new ShopifyAuthError(401, SHOP)) };
    const mod = await import("../src/shopify-sync");
    const failing = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => authFailApi,
      appUrl: "https://app.example",
    });

    await expect(failing(jobStub(tenantId))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(failing(jobStub(tenantId))).rejects.toBeInstanceOf(UnrecoverableError);

    const runs = await prismaService.syncRun.findMany({
      where: { tenantId },
      orderBy: { startedAt: "desc" },
      take: 2,
    });
    expect(await prismaService.syncRun.count({ where: { tenantId } })).toBe(before + 2);
    for (const run of runs) {
      expect(run.status).toBe("failed");
      expect(run.finishedAt).not.toBeNull();
      expect(run.error).toContain("401");
    }
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

  it("drops the cached token when Shopify rejects it mid-sync", async () => {
    // The cache expires on the token's STATED lifetime, so a token revoked
    // early stayed in memory and was re-presented every tick. Three rejections
    // is AUTH_FAILURES_BEFORE_PAUSE, so a recoverable rejection could pause the
    // store until someone redeployed the worker.
    const invalidated: string[] = [];
    const spyCache = {
      get: async () => "token-from-cache",
      invalidate: (shopDomain: string) => invalidated.push(shopDomain),
      get size() {
        return 0;
      },
    } as unknown as Parameters<typeof import("../src/shopify-sync").createShopifySyncProcessor>[0]["tokenCache"];

    const authFailApi = { ...fakeApi, products: async () => Promise.reject(new ShopifyAuthError(401, SHOP)) };
    const mod = await import("../src/shopify-sync");
    const failing = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => authFailApi,
      appUrl: "https://app.example",
      tokenCache: spyCache,
    });

    await expect(failing(jobStub(tenantId))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(invalidated).toEqual([SHOP]);
  });
  it("falls back to BETTER_AUTH_URL for the webhook callback, and says so when neither is set", async () => {
    // Two variables held the same value and only one was set on the worker, so
    //  skipped registration in silence: zero webhooks were ever
    // received on any store, for the life of the deployment, while the
    // fifteen-minute poll made everything look healthy.
    const mod = await import("../src/shopify-sync");
    const before = { app: process.env.SHOPIFY_APP_URL, auth: process.env.BETTER_AUTH_URL };
    try {
      delete process.env.SHOPIFY_APP_URL;
      process.env.BETTER_AUTH_URL = "https://app.example.test/";
      webhookCalls.length = 0;
      await mod.createShopifySyncProcessor({ publisher, makeApi: () => fakeApi })(jobStub(tenantId));
      expect(webhookCalls).toEqual(["https://app.example.test/api/webhooks/shopify"]);

      // Neither set: no registration, but it is announced rather than silent.
      delete process.env.BETTER_AUTH_URL;
      webhookCalls.length = 0;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await mod.createShopifySyncProcessor({ publisher, makeApi: () => fakeApi })(jobStub(tenantId));
      expect(webhookCalls).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toContain("webhooks not registered");
      warn.mockRestore();

      // An explicit value still wins over the fallback.
      process.env.SHOPIFY_APP_URL = "https://explicit.example.test";
      process.env.BETTER_AUTH_URL = "https://auth.example.test";
      webhookCalls.length = 0;
      await mod.createShopifySyncProcessor({ publisher, makeApi: () => fakeApi })(jobStub(tenantId));
      expect(webhookCalls).toEqual(["https://explicit.example.test/api/webhooks/shopify"]);
    } finally {
      if (before.app === undefined) delete process.env.SHOPIFY_APP_URL;
      else process.env.SHOPIFY_APP_URL = before.app;
      if (before.auth === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = before.auth;
    }
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

  it("says the credentials are missing rather than blaming the store's token", async () => {
    // An OAuth connection's stored token was minted by the client-credentials
    // grant and lives about a day. With no app credentials there is nothing to
    // mint with, and presenting the stale token earns a 403 that reads "token
    // revoked or app uninstalled" — sending the next person after a revocation
    // that never happened. The store is fine; the workspace is unconfigured.
    await prismaService.shopifyConnection.updateMany({
      where: { tenantId },
      data: { authMode: "oauth" },
    });
    try {
      await expect(processor(jobStub(tenantId))).rejects.toThrow(/no Shopify app credentials/);
    } finally {
      await prismaService.shopifyConnection.updateMany({
        where: { tenantId },
        data: { authMode: "token" },
      });
    }
  });

  it("sellable stock excludes committed units, by exactly the committed count", async () => {
    // The client's correction, stated as arithmetic: 6 on the shelf, 2 promised
    // to customers, 4 sellable. Counting 6 is what inflated days-of-cover and
    // made the buy list order 2 short on this product.
    const level = await prismaService.inventoryLevel.findFirstOrThrow({
      where: { tenantId, onHand: 6 },
    });
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "ARG-100" },
    });
    const committed = level.onHand - (level.available ?? level.onHand);
    expect(committed).toBe(2);
    expect(product.currentStock).toBe(level.onHand - committed);
  });

  it("repeats of the same failure raise the bell once, not once per tick", async () => {
    // A revoked token fails every 15 minutes indefinitely. Before this window the
    // bell took a row per tick — hundreds of copies of one sentence.
    await prismaService.notification.deleteMany({ where: { tenantId, kind: "shopify_reconnect" } });
    await prismaService.shopifyConnection.updateMany({
      where: { tenantId },
      data: { authFailureCount: 0, syncPausedAt: null },
    });
    const wrapped = new UnrecoverableError(new ShopifyAuthError(401, SHOP).message);
    await handleFailure(jobStub(tenantId), wrapped, publisher);
    await handleFailure(jobStub(tenantId), wrapped, publisher);
    // Counted by title, not kind: the third failure trips the pause, whose
    // notice is a different sentence and is meant to get through.
    const same = await prismaService.notification.count({
      where: { tenantId, title: "Shopify connection needs attention" },
    });
    expect(same).toBe(1);
  });

  it("a different failure still gets through while a reconnect notice is live", async () => {
    // The window is per kind+title. A store that is both unreachable and broken in
    // some other way must not have the second problem swallowed by the first.
    const before = await prismaService.notification.count({ where: { tenantId, kind: "sync_failed" } });
    await handleFailure(jobStub(tenantId), new UnrecoverableError("locations pull returned nothing"), publisher);
    expect(await prismaService.notification.count({ where: { tenantId, kind: "sync_failed" } })).toBe(before + 1);
  });

  it("gives up on a store after three auth failures in a row, and says so once", async () => {
    await prismaService.notification.deleteMany({ where: { tenantId } });
    await prismaService.shopifyConnection.updateMany({
      where: { tenantId },
      data: { authFailureCount: 0, syncPausedAt: null },
    });
    const wrapped = new UnrecoverableError(new ShopifyAuthError(401, SHOP).message);

    await handleFailure(jobStub(tenantId), wrapped, publisher);
    await handleFailure(jobStub(tenantId), wrapped, publisher);
    let conn = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
    // Two is a blip — scope propagation right after an install looks like this.
    expect(conn!.syncPausedAt).toBeNull();
    expect(conn!.authFailureCount).toBe(2);

    await handleFailure(jobStub(tenantId), wrapped, publisher);
    conn = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
    expect(conn!.syncPausedAt).not.toBeNull();
    expect(conn!.lastAuthError).toContain("auth failed");

    // Further ticks change nothing and add nothing.
    await handleFailure(jobStub(tenantId), wrapped, publisher);
    const paused = await prismaService.notification.count({
      where: { tenantId, title: "Shopify syncs are paused" },
    });
    expect(paused).toBe(1);
  });

  it("a sync that works again un-pauses the store", async () => {
    await prismaService.shopifyConnection.updateMany({
      where: { tenantId },
      data: { authFailureCount: 3, syncPausedAt: new Date(), lastAuthError: "auth failed (403)" },
    });

    await processor(jobStub(tenantId));

    const conn = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
    expect(conn!.syncPausedAt).toBeNull();
    expect(conn!.authFailureCount).toBe(0);
    expect(conn!.lastAuthError).toBeNull();
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

const LIFECYCLE_SLUG = "shopify-lifecycle-test";
const LIFECYCLE_SHOP = "lifecycle-test-store.myshopify.com";

/**
 * The catalogue shapes the old ingest lost silently: a three-shade product that
 * collapsed into one row carrying another shade's stock, and draft/archived
 * products the query filtered out of the pull entirely.
 */
function lifecycleCatalogue(): ShopifyProductNode[] {
  return [
    {
      id: "gid://shopify/Product/301",
      title: "Matte Foundation",
      vendor: "Beauty Co",
      status: "ACTIVE",
      publishedAt: "2026-01-05T00:00:00Z",
      variants: [
        {
          id: "gid://shopify/ProductVariant/401",
          sku: "FND-01",
          title: "Shade 01",
          price: "1500",
          inventoryItem: { id: "gid://shopify/InventoryItem/501", unitCost: { amount: "900" } },
        },
        {
          id: "gid://shopify/ProductVariant/402",
          sku: "FND-02",
          title: "Shade 02",
          price: "1600",
          inventoryItem: { id: "gid://shopify/InventoryItem/502", unitCost: { amount: "950" } },
        },
        {
          id: "gid://shopify/ProductVariant/403",
          sku: "FND-03",
          title: "Shade 03",
          price: "1600",
          inventoryItem: { id: "gid://shopify/InventoryItem/503" },
        },
      ],
    },
    {
      // Not yet launched: still stocked and still worth showing, just not orderable.
      id: "gid://shopify/Product/302",
      title: "Winter Balm",
      status: "DRAFT",
      publishedAt: null,
      variants: [
        {
          id: "gid://shopify/ProductVariant/404",
          sku: "BALM-01",
          title: "Default Title",
          price: "400",
          inventoryItem: { id: "gid://shopify/InventoryItem/504", unitCost: { amount: "200" } },
        },
      ],
    },
    {
      id: "gid://shopify/Product/303",
      title: "Discontinued Toner",
      status: "ARCHIVED",
      publishedAt: "2025-03-01T00:00:00Z",
      variants: [
        {
          id: "gid://shopify/ProductVariant/405",
          sku: "TON-01",
          title: "Default Title",
          price: "900",
          inventoryItem: { id: "gid://shopify/InventoryItem/505", unitCost: { amount: "500" } },
        },
      ],
    },
  ];
}

// Two shades of one product, stocked separately at the same branch.
const lifecycleLocations: ShopifyLocationNode[] = [
  {
    id: "gid://shopify/Location/9101",
    name: "Downtown Shop",
    isActive: true,
    inventoryLevels: [
      {
        quantities: [
          { name: "available", quantity: 5 },
          { name: "on_hand", quantity: 5 },
        ],
        item: { id: "gid://shopify/InventoryItem/501", variant: { id: "gid://shopify/ProductVariant/401", product: { id: "gid://shopify/Product/301" } } },
      },
      {
        quantities: [
          { name: "available", quantity: 9 },
          { name: "on_hand", quantity: 9 },
        ],
        item: { id: "gid://shopify/InventoryItem/502", variant: { id: "gid://shopify/ProductVariant/402", product: { id: "gid://shopify/Product/301" } } },
      },
    ],
  },
];

describe.skipIf(!runnable)("product lifecycle ingest (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let processor: (job: Job<SyncJobData>) => Promise<void>;
  let publisher: Redis;
  let tenantId: string;
  let catalogue = lifecycleCatalogue();

  const bySku = async (sku: string) =>
    (await prismaService.product.findFirst({ where: { tenantId, sku } }))!;

  /** Drop the products cursor so the next run is a FULL catalogue pull — the
   *  only mode allowed to decide a SKU has gone from the store. */
  const forceFullSync = () =>
    prismaService.ingestCursor.deleteMany({
      where: { tenantId, source: "shopify", resource: "products" },
    });

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    const mod = await import("../src/shopify-sync");

    publisher = new Redis(redisUrl!);
    processor = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => ({
        ensureWebhooks: async () => {},
        // These suites assert catalogue behaviour; the store's currency is not
        // part of it, so report none and leave the workspace's value alone.
        shopSettings: async () => ({ currencyCode: null }),
        products: async () => catalogue,
        locations: async () => lifecycleLocations,
        orders: async () => [],
      }),
    });

    await prismaService.tenant.deleteMany({ where: { slug: LIFECYCLE_SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Lifecycle Test", slug: LIFECYCLE_SLUG },
    });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: LIFECYCLE_SHOP,
        accessToken: encryptToken(TOKEN),
        authMode: "token",
        scopes: "read_products",
      },
    });
    await processor(jobStub(tenantId)); // first run: no cursor → full sync
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: LIFECYCLE_SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  it("writes one row per variant, each with its own SKU, price and cost", async () => {
    const shades = await prismaService.product.findMany({
      where: { tenantId, shopifyProductId: "301" },
      orderBy: { sku: "asc" },
    });
    expect(shades.map((s) => s.sku)).toEqual(["FND-01", "FND-02", "FND-03"]);
    expect(shades.map((s) => s.shopifyVariantId)).toEqual(["401", "402", "403"]);
    expect(shades.map((s) => s.variantTitle)).toEqual(["Shade 01", "Shade 02", "Shade 03"]);
    expect(shades.map((s) => s.priceKes)).toEqual([1500, 1600, 1600]);
    expect(shades.map((s) => s.costKes)).toEqual([900, 950, 0]); // no unit cost on Shade 03
    // Product-level fields are copied onto every sibling.
    expect(shades.every((s) => s.title === "Matte Foundation" && s.vendor === "Beauty Co")).toBe(true);
  });

  it("ingests draft and archived products instead of dropping them", async () => {
    const balm = await bySku("BALM-01");
    expect(balm.shopifyStatus).toBe("draft");
    expect(balm.publishedAt).toBeNull(); // never published — Shopify's unlisted
    expect(balm.variantTitle).toBeNull(); // "Default Title" is plumbing, not a name
    const toner = await bySku("TON-01");
    expect(toner.shopifyStatus).toBe("archived");
    expect(toner.publishedAt?.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    // They stay in the catalogue but off the buy list; the shades stay on it.
    const buyable = await prismaService.product.count({
      where: { tenantId, shopifyStatus: { notIn: ["draft", "archived"] }, missingFromShopifyAt: null },
    });
    expect(buyable).toBe(3);
  });

  it("lands each variant's stock on its own row, not on a sibling", async () => {
    expect((await bySku("FND-01")).currentStock).toBe(5);
    expect((await bySku("FND-02")).currentStock).toBe(9);
    expect((await bySku("FND-03")).currentStock).toBe(0); // stocked nowhere
  });

  it("never overwrites an owner-pinned cost", async () => {
    await prismaService.product.updateMany({
      where: { tenantId, sku: "FND-01" },
      data: { costKes: 1234, costSource: "manual" },
    });
    await processor(jobStub(tenantId));
    const pinned = await bySku("FND-01");
    expect(pinned.costKes).toBe(1234);
    expect(pinned.costSource).toBe("manual");
    expect((await bySku("FND-02")).costKes).toBe(950); // unpinned rows still follow Shopify
  });

  it("a FULL sync marks a SKU that has gone from the store", async () => {
    catalogue = lifecycleCatalogue();
    catalogue[0]!.variants = catalogue[0]!.variants!.filter((v) => v.sku !== "FND-03");
    await forceFullSync();
    await processor(jobStub(tenantId));

    expect((await bySku("FND-03")).missingFromShopifyAt).not.toBeNull();
    expect((await bySku("FND-01")).missingFromShopifyAt).toBeNull();
  });

  it("an INCREMENTAL sync never marks anything missing", async () => {
    // An incremental pull legitimately returns only what changed — treating the
    // rest as gone would empty the shop's catalogue in one run.
    catalogue = [{ ...lifecycleCatalogue()[0]!, variants: [lifecycleCatalogue()[0]!.variants![0]!] }];
    await processor(jobStub(tenantId)); // cursor is set from the previous run
    expect((await bySku("FND-02")).missingFromShopifyAt).toBeNull();
    expect((await bySku("TON-01")).missingFromShopifyAt).toBeNull();
  });

  it("a SKU that comes back clears the missing stamp", async () => {
    catalogue = lifecycleCatalogue();
    await forceFullSync();
    await processor(jobStub(tenantId));
    expect((await bySku("FND-03")).missingFromShopifyAt).toBeNull();
  });

  it("records a failing record on its own row and still syncs the rest", async () => {
    catalogue = lifecycleCatalogue();
    // A timestamp the store should never send: it fails this row's write only.
    catalogue[1]!.publishedAt = "not-a-real-date";
    await processor(jobStub(tenantId));

    const balm = await bySku("BALM-01");
    expect(balm.syncError).not.toBeNull();
    expect(balm.syncErrorAt).not.toBeNull();
    // The rest of the pull went through, and a clean write clears the flag.
    expect((await bySku("FND-02")).syncError).toBeNull();

    catalogue = lifecycleCatalogue();
    await processor(jobStub(tenantId));
    expect((await bySku("BALM-01")).syncError).toBeNull();
    expect((await bySku("BALM-01")).syncErrorAt).toBeNull();
  });
});

const ONROUTE_SLUG = "shopify-onroute-test";
const ONROUTE_SHOP = "onroute-test-store.myshopify.com";

/** One ordinary shop, one product. No warehouse, no location named anything
 *  the role guesser would read as en-route — the setup almost every Shopify
 *  merchant actually has. */
const onRouteCatalogue: ShopifyProductNode[] = [
  {
    id: "gid://shopify/Product/701",
    title: "Cleansing Balm",
    vendor: "Beauty Co",
    status: "ACTIVE",
    variants: [
      {
        id: "gid://shopify/ProductVariant/801",
        sku: "CLB-01",
        price: "2000",
        inventoryItem: { id: "gid://shopify/InventoryItem/901", unitCost: { amount: "1200" } },
      },
    ],
  },
];

/** Shopify reports a purchase order / transfer as `incoming` AGAINST THE
 *  DESTINATION, which here is the shop itself. */
const onRouteLocations: ShopifyLocationNode[] = [
  {
    id: "gid://shopify/Location/9201",
    name: "Kilimani",
    isActive: true,
    inventoryLevels: [
      {
        quantities: [
          { name: "available", quantity: 3 },
          { name: "on_hand", quantity: 3 },
          { name: "incoming", quantity: 20 },
        ],
        item: { id: "gid://shopify/InventoryItem/901", variant: { id: "gid://shopify/ProductVariant/801", product: { id: "gid://shopify/Product/701" } } },
      },
    ],
  },
];

describe.skipIf(!runnable)("on-route without an en-route location (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let processor: (job: Job<SyncJobData>) => Promise<void>;
  let publisher: Redis;
  let tenantId: string;

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    const mod = await import("../src/shopify-sync");

    publisher = new Redis(redisUrl!);
    processor = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => ({
        ensureWebhooks: async () => {},
        shopSettings: async () => ({ currencyCode: null }),
        products: async () => onRouteCatalogue,
        locations: async () => onRouteLocations,
        orders: async () => [],
      }),
    });

    await prismaService.tenant.deleteMany({ where: { slug: ONROUTE_SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "On Route Test", slug: ONROUTE_SLUG },
    });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: ONROUTE_SHOP,
        accessToken: encryptToken(TOKEN),
        authMode: "token",
        scopes: "read_products",
      },
    });
    await processor(jobStub(tenantId));
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: ONROUTE_SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  it("counts incoming stock as on-order even though no location is typed en-route", async () => {
    // The regression this guards: onOrder used to be built only from on-hand at
    // en-route-typed locations, so a shop like this one reported nothing
    // incoming forever and the buy list kept recommending stock already paid for.
    const locations = await prismaService.location.findMany({ where: { tenantId } });
    expect(locations).toHaveLength(1);
    expect(locations[0]!.locationType).toBe("branch"); // NOT enroute

    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "CLB-01" },
    });
    expect(product.currentStock).toBe(3);
    expect(product.onOrder).toBe(20);
  });

  it("drops on-order back to zero once the stock has arrived", async () => {
    // Full-snapshot semantics: the delivery lands as on-hand and Shopify stops
    // reporting it incoming, so on-route has to clear itself without anyone
    // marking anything received.
    onRouteLocations[0]!.inventoryLevels![0]!.quantities = [
      { name: "available", quantity: 23 },
      { name: "on_hand", quantity: 23 },
      { name: "incoming", quantity: 0 },
    ];
    await processor(jobStub(tenantId));

    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "CLB-01" },
    });
    expect(product.currentStock).toBe(23);
    expect(product.onOrder).toBe(0);
  });
});

describe("catalogue notice wording", () => {
  const base = { written: 0, failed: 0, created: 0, createdWithoutCost: 0, duplicateSkus: 0 };

  it("says nothing when a run brought in nothing worth interrupting anyone for", async () => {
    const { catalogueNoticeTitle } = await import("../src/shopify-sync");
    // The common case by far: a sync every 15 minutes that changed nothing.
    expect(catalogueNoticeTitle(base)).toBeNull();
    expect(catalogueNoticeTitle({ ...base, written: 400 })).toBeNull();
  });

  it("names what arrived and what needs a person", async () => {
    const { catalogueNoticeTitle } = await import("../src/shopify-sync");
    expect(catalogueNoticeTitle({ ...base, created: 1 })).toBe("Catalogue: 1 new product");
    expect(catalogueNoticeTitle({ ...base, created: 4, createdWithoutCost: 2 })).toBe(
      "Catalogue: 4 new products, 2 with no cost"
    );
    expect(
      catalogueNoticeTitle({ ...base, created: 4, createdWithoutCost: 2, duplicateSkus: 1 })
    ).toBe("Catalogue: 4 new products, 2 with no cost, 1 duplicate SKU");
    // A duplicate can turn up with no new product at all — a rename that
    // collides with an existing SKU, say.
    expect(catalogueNoticeTitle({ ...base, duplicateSkus: 3 })).toBe(
      "Catalogue: 3 duplicate SKUs"
    );
  });
});

const NOTICE_SLUG = "shopify-notice-test";
const NOTICE_SHOP = "notice-test-store.myshopify.com";

/** Two products, one of which Shopify sends with no unit cost. */
const noticeCatalogue: ShopifyProductNode[] = [
  {
    id: "gid://shopify/Product/901",
    title: "Priced Balm",
    status: "ACTIVE",
    variants: [
      {
        id: "gid://shopify/ProductVariant/1001",
        sku: "NOTE-PRICED",
        price: "1000",
        inventoryItem: { id: "gid://shopify/InventoryItem/1101", unitCost: { amount: "600" } },
      },
    ],
  },
  {
    id: "gid://shopify/Product/902",
    title: "Costless Balm",
    status: "ACTIVE",
    variants: [
      {
        id: "gid://shopify/ProductVariant/1002",
        sku: "NOTE-COSTLESS",
        price: "1200",
        inventoryItem: { id: "gid://shopify/InventoryItem/1102" }, // no unitCost
      },
    ],
  },
];

describe.skipIf(!runnable)("catalogue notices (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let processor: (job: Job<SyncJobData>) => Promise<void>;
  let publisher: Redis;
  let tenantId: string;

  const notices = () =>
    prismaService.notification.findMany({
      where: { tenantId, kind: "catalogue_review" },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    const mod = await import("../src/shopify-sync");
    publisher = new Redis(redisUrl!);
    processor = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => ({
        ensureWebhooks: async () => {},
        shopSettings: async () => ({ currencyCode: null }),
        products: async () => noticeCatalogue,
        locations: async () => [],
        orders: async () => [],
      }),
    });

    await prismaService.tenant.deleteMany({ where: { slug: NOTICE_SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Notice Test", slug: NOTICE_SLUG },
    });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: NOTICE_SHOP,
        accessToken: encryptToken(TOKEN),
        authMode: "token",
        scopes: "read_products",
      },
    });
  }, 30_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: NOTICE_SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  it("raises one notice naming the new products and the one with no cost", async () => {
    await processor(jobStub(tenantId));
    const raised = await notices();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toBe("Catalogue: 2 new products, 1 with no cost");
  });

  it("says nothing on a second run that brings in nothing new", async () => {
    // The reason dedup matters at all: this runs every 15 minutes. A notice per
    // sync would bury the bell within a day.
    await processor(jobStub(tenantId));
    await processor(jobStub(tenantId));
    expect(await notices()).toHaveLength(1);
  });
});

const CHUNK_SLUG = "sales-chunk-test";
const CHUNK_SHOP = "chunk-test-store.myshopify.com";

// One product, two branches, on the SAME day — with enough other trading days
// between them to push the two rows into different write chunks.
const CHUNK_DAY = "2026-06-04";
const chunkCatalogue: ShopifyProductNode[] = [
  {
    id: "gid://shopify/Product/101",
    title: "Argan Oil 100ml",
    variants: [
      { id: "gid://shopify/ProductVariant/201", sku: "ARG-100", title: "Default Title", price: "1200" },
    ],
  },
];
const chunkLocations: ShopifyLocationNode[] = [
  { id: "gid://shopify/Location/9001", name: "Kilimani Store", isActive: true, inventoryLevels: [] },
  { id: "gid://shopify/Location/9002", name: "Westlands Store", isActive: true, inventoryLevels: [] },
];

function chunkLine(quantity: number) {
  return [
    {
      quantity,
      product: { id: "gid://shopify/Product/101" },
      originalUnitPriceSet: { shopMoney: { amount: "1200" } },
    },
  ];
}

// Midday so the tenant's day never shifts under the UTC date.
const chunkOrders: ShopifyOrderNode[] = [
  {
    id: "gid://shopify/Order/1",
    processedAt: `${CHUNK_DAY}T09:00:00Z`,
    fulfillments: [{ location: { id: "gid://shopify/Location/9001" } }],
    lineItems: chunkLine(2),
  },
  // 600 other trading days for the same product — each its own bucket, none
  // colliding with CHUNK_DAY.
  ...Array.from({ length: 600 }, (_, i) => ({
    id: `gid://shopify/Order/${100 + i}`,
    processedAt: `${new Date(Date.UTC(2024, 0, 2 + i, 12)).toISOString()}`,
    lineItems: chunkLine(1),
  })),
  {
    id: "gid://shopify/Order/2",
    processedAt: `${CHUNK_DAY}T15:00:00Z`,
    fulfillments: [{ location: { id: "gid://shopify/Location/9002" } }],
    lineItems: chunkLine(3),
  },
];

describe.skipIf(!runnable)("sales writes across chunk boundaries (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let publisher: Redis;
  let tenantId: string;

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    const mod = await import("../src/shopify-sync");

    publisher = new Redis(redisUrl!);
    const processor = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => ({
        ensureWebhooks: async () => {},
        shopSettings: async () => ({ currencyCode: null }),
        products: async () => chunkCatalogue,
        locations: async () => chunkLocations,
        orders: async () => chunkOrders,
      }),
    });

    await prismaService.tenant.deleteMany({ where: { slug: CHUNK_SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Chunk Test", slug: CHUNK_SLUG, timezone: "Africa/Nairobi" },
    });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: CHUNK_SHOP,
        accessToken: encryptToken(TOKEN),
        authMode: "token",
        scopes: "read_products",
      },
    });
    await processor(jobStub(tenantId));
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: CHUNK_SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  it("keeps both branches of a day whose rows land in different chunks", async () => {
    // The write goes out in chunks, and the clear cannot key on the branch — a
    // re-sync has to be able to drop a branch that no longer traded — so it
    // takes the whole day. Interleave the two and a later chunk's delete takes
    // out the sibling branch an earlier chunk just wrote, silently, on a run
    // that reports success.
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "ARG-100" },
    });
    const locations = await prismaService.location.findMany({ where: { tenantId } });
    const byCore = new Map(locations.map((l) => [l.shopifyLocationId, l.id]));

    const rows = await prismaService.salesHistory.findMany({
      where: { tenantId, productId: product.id, date: new Date(`${CHUNK_DAY}T00:00:00.000Z`) },
    });

    expect(new Map(rows.map((r) => [r.locationId, r.quantity]))).toEqual(
      new Map([
        [byCore.get("9001"), 2],
        [byCore.get("9002"), 3],
      ])
    );
  });

  it("still writes every other trading day exactly once", async () => {
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "ARG-100" },
    });
    const total = await prismaService.salesHistory.count({
      where: { tenantId, productId: product.id },
    });
    expect(total).toBe(602);
  });
});
