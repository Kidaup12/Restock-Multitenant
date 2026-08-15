import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type { Job } from "bullmq";
import { Redis } from "ioredis";
import type { SyncJobData } from "@wezesha/queue";
import {
  encryptToken,
  type ShopifyLocationNode,
  type ShopifyOrderNode,
  type ShopifyProductNode,
} from "@wezesha/shopify";

/**
 * One field was answering two questions.
 *
 * The cursor says "where have we read up to" and MUST advance on every run, or
 * the next delta window re-fetches from the beginning. Freshness says "when did
 * anything actually arrive", and must NOT advance on a run that ingested
 * nothing — it is the only thing standing between a shop and a screenful of
 * frozen figures that all render perfectly.
 *
 * Stamping the cursor unconditionally made the two the same value, so a
 * connected store that returns nothing for ever looked as fresh as one selling
 * all day. This suite pins them apart: a silent run moves the cursor and leaves
 * freshness where it was, and a run that ingests something moves both.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "sync-freshness-test";
const SHOP = "sync-freshness-store.myshopify.com";
const TOKEN = "shpat_sync_freshness_token";

const products: ShopifyProductNode[] = [
  {
    id: "gid://shopify/Product/701",
    title: "Coconut Oil 500ml",
    variants: [
      {
        id: "gid://shopify/ProductVariant/801",
        sku: "COCO-500",
        title: "Default Title",
        price: "900",
        inventoryItem: { id: "gid://shopify/InventoryItem/901", unitCost: { amount: "500" } },
      },
    ],
  },
];

/** One selling branch holding one SKU, at whatever quantity the run reports. */
function locationsAt(quantity: number): ShopifyLocationNode[] {
  return [
    {
      id: "gid://shopify/Location/7001",
      name: "Main Store",
      isActive: true,
      inventoryLevels: [
        {
          quantities: [
            { name: "available", quantity },
            { name: "on_hand", quantity },
          ],
          item: {
            id: "gid://shopify/InventoryItem/901",
            variant: {
              id: "gid://shopify/ProductVariant/801",
              product: { id: "gid://shopify/Product/701" },
            },
          },
        },
      ],
    },
  ];
}

function orderOn(day: string): ShopifyOrderNode {
  return {
    id: `gid://shopify/Order/${day.replace(/-/g, "")}`,
    processedAt: `${day}T10:00:00Z`,
    createdAt: `${day}T10:00:00Z`,
    lineItems: [
      {
        quantity: 2,
        originalTotalSet: { shopMoney: { amount: "1800" } },
        variant: { id: "gid://shopify/ProductVariant/801", product: { id: "gid://shopify/Product/701" } },
      },
    ],
  } as unknown as ShopifyOrderNode;
}

function jobStub(tenantId: string): Job<SyncJobData> {
  return {
    data: { tenantId, source: "shopify" },
    opts: { attempts: 6 },
    attemptsMade: 1,
  } as unknown as Job<SyncJobData>;
}

describe.skipIf(!runnable)("sync freshness vs cursor (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let processor: (job: Job<SyncJobData>) => Promise<void>;
  let publisher: Redis;
  let tenantId: string;

  /** What the fake store hands back on the next run. Flipped between runs so a
   *  single processor can play "busy shop" and "silent shop" in turn. */
  let payload: {
    products: ShopifyProductNode[];
    locations: ShopifyLocationNode[];
    orders: ShopifyOrderNode[];
  } = { products, locations: locationsAt(12), orders: [orderOn("2026-05-04")] };

  const cursorRows = () =>
    prismaService.ingestCursor.findMany({
      where: { tenantId, source: "shopify" },
      orderBy: { resource: "asc" },
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
        products: async () => payload.products,
        locations: async () => payload.locations,
        orders: async () => payload.orders,
      }),
    });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Sync Freshness", slug: SLUG },
    });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: SHOP,
        accessToken: encryptToken(TOKEN),
        authMode: "token",
        scopes: "read_products",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  it("a run that ingests data stamps freshness alongside the cursor", async () => {
    await processor(jobStub(tenantId));

    const rows = await cursorRows();
    expect(rows.map((r) => r.resource)).toEqual(["inventory", "orders", "products"]);
    for (const row of rows) {
      // The discriminating half. Without it, "always report stale" would pass
      // every assertion in the silent-run test below.
      expect(row.dataAt, `${row.resource} recorded no arrival`).not.toBeNull();
      expect(row.dataAt!.getTime()).toBe(row.cursor.getTime());
    }
  }, 60_000);

  it("silent runs advance the cursor and leave freshness where it was", async () => {
    const before = new Map((await cursorRows()).map((r) => [r.resource, r]));

    // The store answers, politely, with nothing — no changed products, no
    // inventory movement, no orders. This is the shape of every one of the ~96
    // daily runs against a store that has quietly stopped sending.
    payload = { products: [], locations: [], orders: [] };
    await processor(jobStub(tenantId));
    await processor(jobStub(tenantId));

    for (const row of await cursorRows()) {
      const was = before.get(row.resource)!;
      // The delta window must keep moving, or the next real pull re-fetches a
      // year of orders.
      expect(row.cursor.getTime(), `${row.resource} cursor stalled`).toBeGreaterThan(
        was.cursor.getTime()
      );
      // Freshness must not.
      expect(row.dataAt?.getTime(), `${row.resource} freshness moved on an empty run`).toBe(
        was.dataAt!.getTime()
      );
      expect(row.cursor.getTime()).toBeGreaterThan(row.dataAt!.getTime());
    }
  }, 60_000);

  it("data arriving again moves freshness back up to the cursor", async () => {
    const stale = new Map((await cursorRows()).map((r) => [r.resource, r.dataAt!.getTime()]));

    // A different trading day and a moved stock level: an unchanged re-send of
    // what we already hold is not news, so the fixture has to actually differ.
    payload = { products, locations: locationsAt(9), orders: [orderOn("2026-05-05")] };
    await processor(jobStub(tenantId));

    for (const row of await cursorRows()) {
      expect(row.dataAt!.getTime(), `${row.resource} ignored real data`).toBeGreaterThan(
        stale.get(row.resource)!
      );
      expect(row.dataAt!.getTime()).toBe(row.cursor.getTime());
    }
  }, 60_000);

  it("re-sending the identical inventory snapshot is not fresh data", async () => {
    // The inventory phase has no delta: it re-reads every level every 15
    // minutes, so "the store answered" is worthless as a freshness signal —
    // a shop that stopped trading entirely would look permanently current.
    // Only a level whose numbers actually changed counts.
    const before = (await cursorRows()).find((r) => r.resource === "inventory")!;
    await processor(jobStub(tenantId));

    const after = (await cursorRows()).find((r) => r.resource === "inventory")!;
    expect(after.cursor.getTime()).toBeGreaterThan(before.cursor.getTime());
    expect(after.dataAt!.getTime()).toBe(before.dataAt!.getTime());
  }, 60_000);
});
