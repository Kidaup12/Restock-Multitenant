import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { Redis } from "ioredis";
import type { Job } from "bullmq";
import type { SyncJobData } from "@wezesha/queue";
import { encryptToken } from "@wezesha/shopify";

/**
 * A newly connected store should not wait for the next cron tick.
 *
 * The forecast runs every half hour, so a shop that connected at :08 stared at
 * an empty planner until :37 — the first half hour of the product, spent on a
 * screen with nothing on it. The sync is what makes a forecast possible, so a
 * successful sync for a workspace with no forecast asks for one.
 *
 * The condition that carries the weight is "has no forecast". Asking on every
 * sync would be a second forecast schedule nobody configured, running four times
 * an hour against every store — so the second sync here must stay silent once
 * predictions exist.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "forecast-after-sync-test";
const SHOP = "first-sync-store.myshopify.com";

const fakeApi = {
  products: async () => [
    {
      id: "gid://shopify/Product/701",
      title: "Argan Oil 100ml",
      variants: [
        {
          id: "gid://shopify/ProductVariant/801",
          sku: "FS-ARG-100",
          title: "Default Title",
          price: "1200",
          inventoryItem: {
            id: "gid://shopify/InventoryItem/901",
            unitCost: { amount: "700" },
          },
        },
      ],
    },
  ],
  locations: async () => [],
  orders: async () => [],
  shop: async () => ({ currencyCode: "KES" }),
  ensureWebhooks: async () => {},
};

function jobStub(tenantId: string): Job<SyncJobData> {
  return {
    data: { tenantId, source: "shopify" },
    opts: { attempts: 6 },
    attemptsMade: 1,
  } as unknown as Job<SyncJobData>;
}

describe.skipIf(!runnable)("a first sync asks for a forecast (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let processor: (job: Job<SyncJobData>) => Promise<void>;
  let publisher: Redis;
  let tenantId: string;
  const asked: string[] = [];

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    const mod = await import("../src/shopify-sync");

    publisher = new Redis(redisUrl!);
    processor = mod.createShopifySyncProcessor({
      publisher,
      makeApi: () => fakeApi as never,
      appUrl: "https://app.example",
      onCatalogueReady: async (id) => {
        asked.push(id);
      },
    });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "First Sync Co", slug: SLUG },
    });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: SHOP,
        accessToken: encryptToken("shpat_first_sync_token"),
        scopes: "read_products",
        authMode: "token",
      },
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  it("asks once the catalogue is in, for a workspace that has no forecast", async () => {
    expect(
      await prismaService.prediction.count({ where: { tenantId } }),
      "the fixture already has a forecast — this proves nothing"
    ).toBe(0);

    await processor(jobStub(tenantId));

    expect(asked, "a newly connected store waits for the next cron tick").toEqual([tenantId]);
  });

  it("stays silent on the next sync, once a forecast exists", async () => {
    // Stand in for the run the ask produced. What matters is that predictions
    // now exist, not how they got there.
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "FS-ARG-100" },
    });
    await prismaService.prediction.create({
      data: {
        tenantId,
        productId: product.id,
        runDate: new Date(),
        forecastRunId: "first-sync-test-run",
        layer1Forecast30d: 12,
        layer1Confidence: 0.8,
        layer2Adjustment: 0,
        finalForecast30d: 12,
        daysUntilStockout: 9,
        recommendedQty: 4,
        safetyStock: 2,
        reorderPoint: 6,
        confidence: 0.8,
        reasoning: "fixture",
        urgency: "medium",
        signals: "{}",
      },
    });
    asked.length = 0;

    await processor(jobStub(tenantId));

    expect(asked, "every sync now queues a forecast — a schedule nobody configured").toEqual([]);
  });
});
