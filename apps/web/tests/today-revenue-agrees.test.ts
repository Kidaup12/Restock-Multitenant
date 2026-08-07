import { beforeAll, describe, expect, it } from "vitest";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getTodayMetrics } from "../lib/data/today";
import { getSalesComparison } from "../lib/data/sales";

/**
 * The revenue tile and the chart directly beneath it must report the same
 * number, because they carry the same label.
 *
 * They did not. The tile compared a raw instant against the date column; the
 * chart truncated that instant to a day key and compared strings. The
 * truncation made the boundary day inclusive for the chart and exclusive for
 * the tile, so the chart covered 31 days and the tile 30 — one day's revenue in
 * the chart's numerator and the tile's denominator. On a live workspace that
 * read as KES 681K (+9%) beside KES 706K (+18%), on the first screen of the day.
 *
 * The existing data-modules test could not catch it: it re-implements the
 * tile's own arithmetic as its expectation, so it validates the tile against
 * itself and never looks at the chart. This compares the two producers.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

describe.skipIf(!runnable)("Today's two revenue figures (seeded local db)", () => {
  let seeded: SeedResult;

  beforeAll(async () => {
    seeded = await seedDev();
  }, 120_000);

  it("the tile and the chart report the same 30-day revenue", async () => {
    const tile = await getTodayMetrics(seeded.tenantId, { canViewCosts: true });
    const chart = await getSalesComparison(seeded.tenantId, 30);

    expect(chart.revenueKes).toBeGreaterThan(0);
    expect(chart.revenueKes).toBe(tile.revenue30dKes);
  });

  it("and the same prior window, so their deltas match too", async () => {
    const tile = await getTodayMetrics(seeded.tenantId, { canViewCosts: true });
    const chart = await getSalesComparison(seeded.tenantId, 30);

    expect(chart.priorRevenueKes).toBe(tile.revenuePrev30dKes);

    // The visible symptom was two different percentages, so assert on those
    // rather than only the inputs that feed them.
    const pct = (now: number, prev: number) => (prev > 0 ? ((now - prev) / prev) * 100 : null);
    expect(pct(chart.revenueKes, chart.priorRevenueKes)).toBe(
      pct(tile.revenue30dKes, tile.revenuePrev30dKes),
    );
  });

  it("covers 30 days, not 31", async () => {
    // The chart's window was a day too wide. Its own reported span is what a
    // per-day average divides by, so an off-by-one here understates the average.
    const chart = await getSalesComparison(seeded.tenantId, 30);
    expect(chart.windowDays).toBe(30);
    expect(chart.series.length).toBeLessThanOrEqual(30);
  });
});
