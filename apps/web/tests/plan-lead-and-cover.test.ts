import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { ASSUMED_LEAD_DAYS, NO_STOCKOUT_DAYS } from "@wezesha/forecast";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { getBuyList, type BuyListRow } from "../lib/data/plan";
import { getStockCatalogue } from "../lib/data/stock";
import { rowsToCsv } from "../lib/export/csv";

/**
 * The two numbers a product with incomplete data used to lie about, proved
 * against the seeded local database:
 *
 * 1. Lead time. A product with no supplier and no override has no measured
 *    lead. Plan and Stock must resolve it the same way, and to a real waiting
 *    time — resolving it to zero makes the plan say "order it the day the shelf
 *    empties", which is a stockout for any supplier that isn't instant.
 * 2. Cover. The engine's ~zero-rate cover is an "effectively forever" sentinel,
 *    not a day count. The data layer nulls it so no screen or export can print
 *    it as a number of days.
 *
 * Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

/** Fast mover with low cover — the run always wants to order it. */
const UNSUPPLIED_SKU = "ARI-MJ-90";

let seeded: SeedResult;

describe.skipIf(!runnable)("plan lead time and cover (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    // Strip one product back to the state a fresh Shopify import arrives in:
    // no supplier linked, no lead-time override. This is the `no_supplier`
    // health flag, and it is the default for a tenant that hasn't built its
    // supplier list yet.
    await prismaService.product.updateMany({
      where: { tenantId: seeded.tenantId, sku: UNSUPPLIED_SKU },
      data: { supplierId: null, leadTimeDays: null },
    });
    await runForecast(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  const findRow = (rows: BuyListRow[], excluded: BuyListRow[]): BuyListRow => {
    const row = [...rows, ...excluded].find((r) => r.sku === UNSUPPLIED_SKU);
    expect(row, `${UNSUPPLIED_SKU} must be sized by the run`).toBeDefined();
    return row!;
  };

  it("resolves an unmeasured lead time to the same value on Plan and on Stock", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const catalogue = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });

    const planRow = findRow(buyList!.rows, buyList!.excluded);
    const stockRow = catalogue.find((r) => r.sku === UNSUPPLIED_SKU)!;

    expect(planRow.leadDays).toBe(ASSUMED_LEAD_DAYS);
    expect(stockRow.leadDays).toBe(planRow.leadDays);
  });

  it("never dates the order for the day the shelf empties", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const row = findRow(buyList!.rows, buyList!.excluded);

    // The last safe day to order is the stockout day minus the wait, so it must
    // land strictly earlier than the stockout itself.
    expect(row.daysLeftToOrder).toBe(row.daysUntilStockout! - ASSUMED_LEAD_DAYS);
    expect(row.daysLeftToOrder).toBeLessThan(row.daysUntilStockout!);
    expect(row.orderByDate.getTime()).toBe(
      buyList!.runDate.getTime() + row.daysLeftToOrder * 86_400_000
    );
  });

  it("keeps the assumed lead out of the order size", async () => {
    // The what-if cover floors at the item's MEASURED lead, and this product
    // has none — so asking for a short cover really buys a short cover. Were
    // the assumption used as the floor instead, a request below it would be
    // silently raised to it and both sizes would come back identical.
    const qtyAtCover = async (coverDays: number) => {
      const list = await getBuyList(seeded.tenantId, { canViewCosts: true, coverDays });
      const row = [...list!.rows, ...list!.excluded].find((r) => r.sku === UNSUPPLIED_SKU);
      expect(row, `${UNSUPPLIED_SKU} must survive a ${coverDays}-day cover`).toBeDefined();
      return row!.recommendedQty;
    };

    expect(await qtyAtCover(7)).toBeLessThan(await qtyAtCover(ASSUMED_LEAD_DAYS));
  });

  it("reports 'no stockout in sight' as null, not as 999 days", async () => {
    const target = await prismaService.prediction.findFirst({
      where: { tenantId: seeded.tenantId, recommendedQty: { gt: 0 } },
      select: { id: true, productId: true },
    });
    // A ~zero run rate is what produces the sentinel; write it directly so the
    // clamp is proved on the persisted value whatever path wrote it.
    await prismaService.prediction.update({
      where: { id: target!.id },
      data: { daysUntilStockout: NO_STOCKOUT_DAYS },
    });

    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const row = [...buyList!.rows, ...buyList!.excluded].find(
      (r) => r.predictionId === target!.id
    );
    expect(row!.daysUntilStockout).toBeNull();

    // The export columns take the row value straight through, so the clamp is
    // what keeps "999" out of the CSV and the PDF handed to the shop.
    const csv = rowsToCsv(["Days left"], [[row!.daysUntilStockout]]);
    expect(csv).not.toContain("999");

    await prismaService.prediction.update({
      where: { id: target!.id },
      data: { daysUntilStockout: 0 },
    });
  });
});
