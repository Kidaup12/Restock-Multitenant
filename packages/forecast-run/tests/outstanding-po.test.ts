import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../db/scripts/seed-dev";
import { runForecast } from "../src/run";

/**
 * Stock we have already ordered is stock we must not order again. `Product.onOrder`
 * only carries Shopify's view, so between sending a purchase order and the shop
 * recording the delivery as incoming, the run saw an un-ordered product and sized
 * a second order for it. Skips without a local database.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

let seeded: SeedResult;
let tenantId: string;
let productId: string;
let sku: string;
let title: string;
let baselineQty: number;

/** Create a purchase order for the whole recommended quantity, run, and read back. */
async function qtyWithPo(patch: {
  poNumber: string;
  status: string;
  receivedQty?: number;
}): Promise<number> {
  const po = await prismaService.purchaseOrder.create({
    data: {
      tenantId,
      poNumber: patch.poNumber,
      status: patch.status,
      sentAt: patch.status === "draft" ? null : new Date(),
      subtotalKes: baselineQty * 100,
      lines: {
        create: [
          {
            tenantId, // denormalised on the line too — the RLS policy is uniform
            productId,
            sku,
            title,
            quantity: baselineQty,
            receivedQty: patch.receivedQty ?? 0,
            unitCostKes: 100,
            lineTotalKes: baselineQty * 100,
          },
        ],
      },
    },
    select: { id: true },
  });
  try {
    await runForecast(tenantId);
    const after = await prismaService.prediction.findFirst({
      where: { tenantId, productId },
      select: { recommendedQty: true },
    });
    // A missing row would read as a zero quantity and pass the sent-order case
    // for the wrong reason: the product must still be forecast, just not bought.
    expect(after, "the product must still get a prediction").not.toBeNull();
    return Math.round(after!.recommendedQty);
  } finally {
    await prismaService.purchaseOrder.delete({ where: { id: po.id } });
  }
}

describe.skipIf(!runnable)("a purchase order we sent counts as stock on order", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish degrades to a no-op
    seeded = await seedDev();
    tenantId = seeded.tenantId;

    await runForecast(tenantId);
    const top = await prismaService.prediction.findFirst({
      where: { tenantId, recommendedQty: { gt: 0 } },
      orderBy: { recommendedQty: "desc" },
      select: { productId: true, recommendedQty: true, product: { select: { sku: true, title: true } } },
    });
    expect(top, "seed should want to reorder something").not.toBeNull();
    productId = top!.productId;
    sku = top!.product.sku ?? "SEED-SKU";
    title = top!.product.title;
    baselineQty = Math.round(top!.recommendedQty);
    expect(baselineQty).toBeGreaterThan(0);
  }, 180_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("stops recommending a product whose full quantity is already on a sent order", async () => {
    const after = await qtyWithPo({ poNumber: "PO-ONORDER-SENT", status: "sent" });
    expect(after, "a sent order covers the whole gap, so nothing is left to buy").toBe(0);
  }, 180_000);

  it("keeps recommending it when the order is still a draft", async () => {
    // Nothing has been ordered yet — the buy list warns about drafts separately.
    const after = await qtyWithPo({ poNumber: "PO-ONORDER-DRAFT", status: "draft" });
    expect(after).toBe(baselineQty);
  }, 180_000);

  it("keeps recommending it once the order has been fully received", async () => {
    // Received units are on the shelf, not in transit; counting them again here
    // would suppress the next reorder.
    const after = await qtyWithPo({
      poNumber: "PO-ONORDER-RECEIVED",
      status: "partially_received",
      receivedQty: baselineQty,
    });
    expect(after).toBe(baselineQty);
  }, 180_000);
});
