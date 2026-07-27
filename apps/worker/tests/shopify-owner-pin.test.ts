import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { Redis } from "ioredis";
import type { SyncJobData } from "@wezesha/queue";
import type { Job } from "bullmq";
import { encryptToken, type ShopifyProductNode } from "@wezesha/shopify";

/**
 * The owner's "keep active" pin against a real sync run.
 *
 * The buy-list predicate reads BOTH `active` and `shopifyStatus`, so pinning
 * `active` alone is not enough: a store that reports the SKU archived would take
 * it off the buy list on the very next pull and quietly undo the owner's
 * decision. The pin therefore also holds the stored status — but only against
 * the statuses that stop selling. A store status that still sells writes through
 * as normal, so the pin is a floor rather than a freeze.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "shopify-owner-pin-test";
const SHOP = "owner-pin-store.myshopify.com";
const TOKEN = "shpat_owner_pin_token";

const PINNED_SKU = "PIN-01";
const LOOSE_SKU = "LOOSE-01";

/** Two SKUs of one product, so both see the same store status on every run. */
function catalogueAt(status: string, price = "1200"): ShopifyProductNode[] {
  return [
    {
      id: "gid://shopify/Product/701",
      title: "House Blend Oil",
      status,
      publishedAt: "2026-02-01T00:00:00Z",
      variants: [
        { id: "gid://shopify/ProductVariant/801", sku: PINNED_SKU, title: "500ml", price },
        { id: "gid://shopify/ProductVariant/802", sku: LOOSE_SKU, title: "1L", price },
      ],
    },
  ];
}

function jobStub(tenantId: string): Job<SyncJobData> {
  return { data: { tenantId, source: "shopify" }, opts: { attempts: 6 }, attemptsMade: 1 } as unknown as Job<SyncJobData>;
}

describe.skipIf(!runnable)("owner keep-active pin through the Shopify sync (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let buyableWhere: typeof import("@wezesha/db").BUYABLE_PRODUCT_WHERE;
  let processor: (job: Job<SyncJobData>) => Promise<void>;
  let publisher: Redis;
  let tenantId: string;
  let catalogue = catalogueAt("ACTIVE");

  const bySku = async (sku: string) => (await prismaService.product.findFirst({ where: { tenantId, sku } }))!;
  const onBuyList = async (sku: string) =>
    (await prismaService.product.count({ where: { tenantId, sku, ...buyableWhere } })) === 1;

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");
    ({ prismaService, BUYABLE_PRODUCT_WHERE: buyableWhere } = await import("@wezesha/db"));
    const mod = await import("../src/shopify-sync");

    publisher = new Redis(redisUrl!);
    processor = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => ({
        ensureWebhooks: async () => {},
        products: async () => catalogue,
        locations: async () => [],
        orders: async () => [],
      }),
    });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    tenantId = (await prismaService.tenant.create({ data: { name: "Owner Pin Test", slug: SLUG } })).id;
    await prismaService.shopifyConnection.create({
      data: { tenantId, shopDomain: SHOP, accessToken: encryptToken(TOKEN), scopes: "read_products" },
    });
    await processor(jobStub(tenantId));
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  it("both SKUs start on the buy list, following the store", async () => {
    expect((await bySku(PINNED_SKU)).shopifyStatus).toBe("active");
    expect(await onBuyList(PINNED_SKU)).toBe(true);
    expect(await onBuyList(LOOSE_SKU)).toBe(true);
  });

  it("a sync that says archived cannot retire a pinned SKU, but retires an unpinned one", async () => {
    // The owner pins it — the same write the "Keep active" control makes.
    await prismaService.product.updateMany({
      where: { tenantId, sku: PINNED_SKU },
      data: { active: true, activeOverride: true },
    });

    catalogue = catalogueAt("ARCHIVED");
    await processor(jobStub(tenantId));

    const pinned = await bySku(PINNED_SKU);
    expect(pinned.activeOverride).toBe(true);
    expect(pinned.active).toBe(true);
    expect(pinned.shopifyStatus).toBe("active"); // the archived status never landed
    expect(await onBuyList(PINNED_SKU)).toBe(true);

    // The unpinned sibling follows the store, which is the default behaviour.
    expect((await bySku(LOOSE_SKU)).shopifyStatus).toBe("archived");
    expect(await onBuyList(LOOSE_SKU)).toBe(false);
  });

  it("the pin is a floor, not a freeze: a selling status still writes through", async () => {
    catalogue = catalogueAt("ACTIVE");
    await processor(jobStub(tenantId));
    expect((await bySku(PINNED_SKU)).shopifyStatus).toBe("active");
    // ...and the sibling comes back with it.
    expect(await onBuyList(LOOSE_SKU)).toBe(true);
  });

  it("releasing the pin hands the SKU back to the store's status", async () => {
    await prismaService.product.updateMany({
      where: { tenantId, sku: PINNED_SKU },
      data: { activeOverride: false },
    });
    catalogue = catalogueAt("ARCHIVED");
    await processor(jobStub(tenantId));
    expect((await bySku(PINNED_SKU)).shopifyStatus).toBe("archived");
    expect(await onBuyList(PINNED_SKU)).toBe(false);
  });

  it("a price the store does not supply never overwrites the row's own price", async () => {
    catalogue = catalogueAt("ACTIVE", "1500");
    await processor(jobStub(tenantId));
    expect((await bySku(PINNED_SKU)).priceKes).toBe(1500);

    // The store answers with no price at all — that is unknown, not zero, and
    // writing the zero would wipe a price the owner typed.
    catalogue = catalogueAt("ACTIVE");
    for (const node of catalogue) for (const v of node.variants ?? []) delete v.price;
    await processor(jobStub(tenantId));
    expect((await bySku(PINNED_SKU)).priceKes).toBe(1500);
  });
});
