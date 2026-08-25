import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { getBuyList, removePlanOverride, upsertPlanOverride } from "../lib/data/plan";
import { getProductDetail } from "../lib/data/product-detail";
import { getReorderNeeded } from "../lib/data/today";

/**
 * The same product, quoted on three screens.
 *
 * The contract's wording is that a recommendation reads identically on Today,
 * the plan and product detail. It did not: the first two apply the owner's
 * standing quantity and the third read the run's row straight from the
 * database, so a held-back product the owner had ordered six of reported "0
 * units suggested" on its own page while the buy list, the queue and the
 * purchase order all said six.
 *
 * Asserted across the surfaces rather than against a literal, so the test
 * cannot drift into agreeing with whatever the code happens to produce.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

let seeded: SeedResult;

describe.skipIf(!runnable)("one number on every surface (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await runForecast(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("quotes the owner's quantity on product detail, not the run's", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(buyList!.rows.length, "the buy list is empty, so there is nothing to compare").
      toBeGreaterThan(0);
    const target = buyList!.rows[0]!;
    // The engine's own figure plus a constant: a coincidence cannot satisfy it.
    const owner = Math.round(target.recommendedQty) + 23;

    await upsertPlanOverride(seeded.tenantId, {
      productId: target.productId,
      qty: owner,
      createdByUserId: null,
      createdByName: null,
    });
    try {
      const [plan, detail] = await Promise.all([
        getBuyList(seeded.tenantId, { canViewCosts: true }),
        getProductDetail(seeded.tenantId, target.productId, { canViewCosts: true }),
      ]);
      const planRow = plan!.rows.find((r) => r.productId === target.productId)!;

      expect(planRow.recommendedQty, "the plan dropped the override").toBe(owner);
      expect(detail!.prediction!.recommendedQty, "product detail quoted the run, not the owner").
        toBe(owner);
      expect(detail!.prediction!.overriddenQty).toBe(owner);
      // The point of the test: the two screens agree with each other.
      expect(detail!.prediction!.recommendedQty).toBe(planRow.recommendedQty);
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
    }
  });

  it("falls back to the run's own number when nobody has overridden it", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = buyList!.rows[0]!;
    const detail = await getProductDetail(seeded.tenantId, target.productId, {
      canViewCosts: true,
    });

    expect(detail!.prediction!.overriddenQty).toBeNull();
    expect(detail!.prediction!.recommendedQty).toBe(Math.round(target.recommendedQty));
  });

  it("agrees with Today, which reads the same list", async () => {
    const today = await getReorderNeeded(seeded.tenantId, { canViewCosts: true });
    expect(today!.rows.length, "Today listed nothing to restock").toBeGreaterThan(0);
    const row = today!.rows[0]!;

    const detail = await getProductDetail(seeded.tenantId, row.productId, {
      canViewCosts: true,
    });
    expect(detail!.prediction!.recommendedQty).toBe(row.recommendedQty);
  });
});
