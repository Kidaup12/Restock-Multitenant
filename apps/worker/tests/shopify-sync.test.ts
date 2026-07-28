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
      {
        quantities: [{ name: "on_hand", quantity: 10 }],
        item: { variant: { id: "gid://shopify/ProductVariant/201", product: { id: "gid://shopify/Product/101" } } },
      },
      {
        quantities: [{ name: "on_hand", quantity: 3 }],
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
        quantities: [{ name: "on_hand", quantity: 20 }],
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

    // Levels carry on_hand (not available) + incoming.
    const levels = await prismaService.inventoryLevel.findMany({ where: { tenantId } });
    expect(levels).toHaveLength(4);
    const mainStoreArgan = levels.find((l) => l.locationId === byCore.get("9001")!.id && l.onHand === 6);
    expect(mainStoreArgan?.incoming).toBe(5); // "incoming" quantity stored per level
    expect(argan.id).toBeTruthy();

    // Role-correct rollup: currentStock is SELLS-only (Main Store 6); the
    // warehouse's 10 holds (excluded), and the en-route 20 feeds onOrder.
    const arganFresh = await prismaService.product.findFirst({ where: { tenantId, sku: "ARG-100" } });
    expect(arganFresh?.currentStock).toBe(6);
    expect(arganFresh?.onOrder).toBe(20);
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
        quantities: [{ name: "on_hand", quantity: 5 }],
        item: { id: "gid://shopify/InventoryItem/501", variant: { id: "gid://shopify/ProductVariant/401", product: { id: "gid://shopify/Product/301" } } },
      },
      {
        quantities: [{ name: "on_hand", quantity: 9 }],
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
