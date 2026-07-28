import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../db/scripts/seed-dev";
import { runForecast } from "../src/run";

/**
 * What the shop stopped selling must never earn a forecast, because a forecast
 * is what puts a line on the buy list. The run once filtered on its own pair of
 * flags and so never learned about store status: a product archived in Shopify
 * kept being forecast and kept being ordered, which is the complaint this whole
 * lifecycle change answers. Skips without a local database.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

let seeded: SeedResult;
let tenantId: string;

describe.skipIf(!runnable)("the forecast only covers what the shop still sells", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish degrades to a no-op
    seeded = await seedDev();
    tenantId = seeded.tenantId;
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it.each([
    ["archived in the store", { shopifyStatus: "archived" }],
    ["still a draft", { shopifyStatus: "draft" }],
    ["gone from the store", { missingFromShopifyAt: new Date() }],
  ])("gives no prediction to a product %s", async (_label, patch) => {
    const victim = await prismaService.product.findFirst({
      where: { tenantId, active: true, notForSale: false, shopifyStatus: "active" },
      select: { id: true },
    });
    expect(victim, "seed should provide a sellable product").not.toBeNull();

    await prismaService.product.update({ where: { id: victim!.id }, data: patch });
    try {
      await runForecast(tenantId);
      const rows = await prismaService.prediction.count({
        where: { tenantId, productId: victim!.id },
      });
      expect(rows, "a product the shop stopped selling must not be forecast").toBe(0);
    } finally {
      await prismaService.product.update({
        where: { id: victim!.id },
        data: { shopifyStatus: "active", missingFromShopifyAt: null },
      });
    }
  }, 120_000);

  it("still forecasts an unlisted product", async () => {
    // Unpublished is Shopify's "unlisted", and a shop that sells over the
    // counter publishes nothing at all. On the first real store connected to
    // this app, 38 of 49 sellable products were unpublished — excluding them
    // would have emptied the buy list.
    const victim = await prismaService.product.findFirst({
      where: { tenantId, active: true, notForSale: false, shopifyStatus: "active" },
      select: { id: true },
    });
    await prismaService.product.update({
      where: { id: victim!.id },
      data: { publishedAt: null },
    });
    await runForecast(tenantId);
    const rows = await prismaService.prediction.count({
      where: { tenantId, productId: victim!.id },
    });
    expect(rows, "unlisted is a label, not an exclusion").toBeGreaterThan(0);
  }, 120_000);
});
