import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { getPeriodMetrics, getStockoutTrend } from "../lib/data/insights";

/**
 * Week-by-week metrics, against the local database.
 *
 * The load-bearing case is the FIRST one: the empty-shelf rate on this table
 * must be the identical figure the trend chart plots. They are the same question
 * asked twice on one screen, and this codebase has already shipped two
 * producers of one number more than once — ABC and "needs restocking" both had
 * two, and every suite stayed green over it.
 *
 * The second is the honesty rule inherited from the trend loader: a week with
 * too few snapshot days is DROPPED. A day with no snapshot is missing data, not
 * a day on which nothing was out of stock, and averaging it in would quietly
 * flatter every rate on the page.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "period-metrics-test";
const DAY = 86_400_000;

/** Monday (UTC) of the week `weeksAgo` weeks back — matches the loader's own
 *  bucketing, so fixtures land where the assertions expect them. */
function mondayWeeksAgo(weeksAgo: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - weeksAgo * 7);
  return d;
}

describe.skipIf(!runnable)("week-by-week metrics (local db)", () => {
  let tenantId: string;
  let emptyProductId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Period Metrics Co", slug: SLUG },
    });
    tenantId = tenant.id;

    const alwaysEmpty = await prismaService.product.create({
      data: { tenantId, sku: "PM-EMPTY", title: "Always Empty", priceKes: 500, costKes: 200 },
    });
    const stocked = await prismaService.product.create({
      data: { tenantId, sku: "PM-STOCKED", title: "Well Stocked", priceKes: 500, costKes: 200 },
    });
    // A THIRD stocked product on purpose, so the week's rate is 7/21 = 33.3%
    // rather than a round 50%. With two products any plausible arithmetic —
    // including a wrong one rounding to whole percents — lands on the same
    // number, and the test asserting this table agrees with the chart could not
    // have failed.
    const stockedToo = await prismaService.product.create({
      data: { tenantId, sku: "PM-STOCKED-2", title: "Also Stocked", priceKes: 500, costKes: 200 },
    });
    emptyProductId = alwaysEmpty.id;

    // A FULL week (7 days of snapshots) two weeks back: one product empty
    // throughout, one stocked throughout — an expected rate of exactly 50%.
    const full = mondayWeeksAgo(2);
    const snapshots: { tenantId: string; productId: string; date: Date; onHand: number }[] = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(full.getTime() + d * DAY);
      snapshots.push({ tenantId, productId: alwaysEmpty.id, date, onHand: 0 });
      snapshots.push({ tenantId, productId: stocked.id, date, onHand: 25 });
      snapshots.push({ tenantId, productId: stockedToo.id, date, onHand: 25 });
    }
    // A THIN week (a single day) one week back — must be dropped, not reported.
    const thin = mondayWeeksAgo(1);
    snapshots.push({ tenantId, productId: alwaysEmpty.id, date: thin, onHand: 0 });
    snapshots.push({ tenantId, productId: stocked.id, date: thin, onHand: 25 });
    snapshots.push({ tenantId, productId: stockedToo.id, date: thin, onHand: 25 });
    await prismaService.inventorySnapshot.createMany({ data: snapshots });

    await prismaService.salesHistory.createMany({
      data: [
        {
          tenantId,
          productId: stocked.id,
          date: new Date(full.getTime() + DAY),
          quantity: 4,
          revenueKes: 2000,
        },
        {
          tenantId,
          productId: stocked.id,
          date: new Date(full.getTime() + 2 * DAY),
          quantity: 6,
          revenueKes: 3000,
        },
      ],
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  it("reports the same empty-shelf rate the trend chart plots", async () => {
    const [metrics, trend] = await Promise.all([
      getPeriodMetrics(tenantId, { weeks: 6 }),
      getStockoutTrend(tenantId, { weeks: 6 }),
    ]);
    expect(metrics.weeks.length).toBe(trend.weeks.length);
    for (const [i, week] of metrics.weeks.entries()) {
      expect(
        week.emptyRatePct,
        `week ${week.weekStart.toISOString()} disagrees with the chart`
      ).toBe(trend.weeks[i]!.ratePct);
    }
  });

  it("drops a week with too few snapshot days rather than reporting it thin", async () => {
    const metrics = await getPeriodMetrics(tenantId, { weeks: 6 });
    const thin = mondayWeeksAgo(1).getTime();
    expect(
      metrics.weeks.some((w) => w.weekStart.getTime() === thin),
      "a one-day week was reported as if it were a whole one"
    ).toBe(false);
  });

  it("measures the full week from product-days actually observed", async () => {
    const metrics = await getPeriodMetrics(tenantId, { weeks: 6 });
    const full = metrics.weeks.find((w) => w.weekStart.getTime() === mondayWeeksAgo(2).getTime());
    expect(full, "the complete week is missing").toBeDefined();
    expect(full!.observedProductDays).toBe(21);
    expect(full!.emptyProductDays).toBe(7);
    // 7/21 to one decimal. A whole-percent rounding would say 33 and be wrong.
    expect(full!.emptyRatePct).toBe(33.3);
    expect(full!.unitsSold).toBe(10);
  });

  it("names the product behind the empty days", async () => {
    const metrics = await getPeriodMetrics(tenantId, { weeks: 6 });
    const full = metrics.weeks.find((w) => w.weekStart.getTime() === mondayWeeksAgo(2).getTime());
    const worst = full!.culprits[0];
    expect(worst, "a bad week named no products at all").toBeDefined();
    expect(worst!.productId).toBe(emptyProductId);
    expect(worst!.sku).toBe("PM-EMPTY");
    expect(worst!.emptyDays).toBe(7);
    // The stocked product was never empty, so it has no business being listed.
    expect(full!.culprits.some((c) => c.sku === "PM-STOCKED")).toBe(false);
  });
});
