import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { getSalesComparison, getSalesSeries } from "@/lib/data/sales";
import { trailingWindow } from "@/lib/data/trailing-window";

/**
 * The sales chart is a chart of days, and it was built on the assumption that
 * every stored date IS a day. Two things broke that:
 *
 *  - `date` is a timestamp column, and not every writer stamps midnight. Two
 *    rows a few hours apart on one day grouped as two rows that then formatted
 *    to the same key — one day drawn twice, and counted twice in `tradingDays`.
 *  - the window started at `now - days`, an instant, so the oldest day was in
 *    or out depending on the hour the page was loaded, and the chart covered a
 *    day more than the tile beside it.
 *
 * Both only misbehave at particular times of day, so the clock is injected and
 * every hour is checked rather than whichever one CI happens to run at.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "sales-series-day-grouping";
const DAY_MS = 86_400_000;
/** A fixed day to measure from, so the assertions do not drift with the date. */
const ANCHOR = Date.UTC(2026, 8, 11);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe.skipIf(!runnable)("sales series day grouping (local db)", () => {
  let tenantId: string;
  let productId: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Series", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;
    const product = await prismaService.product.create({
      data: { tenantId, sku: "SS-1", title: "One line", vendor: "House", priceKes: 100 },
    });
    productId = product.id;
  });

  /** Two sales on the same calendar day, stamped hours apart — the shape the
   *  seed and the till feed both produce. */
  async function twoSalesOnOneDay(dayStartMs: number) {
    await prismaService.salesHistory.createMany({
      data: [
        {
          tenantId,
          productId,
          date: new Date(dayStartMs),
          quantity: 2,
          revenueKes: 200,
          channel: "shopify",
        },
        {
          tenantId,
          productId,
          date: new Date(dayStartMs + 19 * 3_600_000),
          quantity: 3,
          revenueKes: 300,
          channel: "pos",
        },
      ],
    });
  }

  it("reports one day, with both sales in it, when a day holds two timestamps", async () => {
    const yesterday = ANCHOR - DAY_MS;
    await twoSalesOnOneDay(yesterday);

    const series = await getSalesSeries(tenantId, 30, new Date(ANCHOR + 10 * 3_600_000));
    const forDay = series.filter((s) => s.date === dayKey(yesterday));

    expect(forDay).toHaveLength(1);
    expect(forDay[0].unitsSold).toBe(5);
    expect(forDay[0].revenueKes).toBe(500);
  });

  it("never repeats a day key, at any hour of the day", async () => {
    await twoSalesOnOneDay(ANCHOR - DAY_MS);
    await twoSalesOnOneDay(ANCHOR - 2 * DAY_MS);

    for (let hour = 0; hour < 24; hour++) {
      const series = await getSalesSeries(tenantId, 30, new Date(ANCHOR + hour * 3_600_000));
      const keys = series.map((s) => s.date);
      expect(new Set(keys).size, `${keys.length} entries at ${hour}:00 UTC`).toBe(keys.length);
    }
  });

  it("counts a two-timestamp day as one trading day, not two", async () => {
    // tradingDays is the series length, and it divides the per-day average.
    await twoSalesOnOneDay(ANCHOR - DAY_MS);
    const comparison = await getSalesComparison(tenantId, 30, new Date(ANCHOR + 9 * 3_600_000));
    expect(comparison.tradingDays).toBe(1);
    expect(comparison.revenueKes).toBe(500);
  });

  it("starts the window on a midnight, so the oldest day does not move with the hour", async () => {
    const { start, startKey } = trailingWindow(30, new Date(ANCHOR));
    // A sale on the first day of the window, and one on the day before it.
    await prismaService.salesHistory.createMany({
      data: [
        { tenantId, productId, date: start, quantity: 1, revenueKes: 100, channel: "shopify" },
        {
          tenantId,
          productId,
          date: new Date(+start - DAY_MS),
          quantity: 1,
          revenueKes: 100,
          channel: "shopify",
        },
      ],
    });

    for (let hour = 0; hour < 24; hour++) {
      const series = await getSalesSeries(tenantId, 30, new Date(ANCHOR + hour * 3_600_000));
      const keys = series.map((s) => s.date);
      expect(keys, `at ${hour}:00 UTC`).toContain(startKey);
      expect(keys, `at ${hour}:00 UTC`).not.toContain(dayKey(+start - DAY_MS));
    }
  });

  it("agrees with the window the rest of the screen uses", async () => {
    await twoSalesOnOneDay(ANCHOR - DAY_MS);
    const now = new Date(ANCHOR + 14 * 3_600_000);
    const { startKey } = trailingWindow(30, now);
    const series = await getSalesSeries(tenantId, 30, now);

    expect(series.length).toBeLessThanOrEqual(30);
    for (const day of series) expect(day.date >= startKey).toBe(true);
  });
});
