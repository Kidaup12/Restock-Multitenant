import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { getTodayMetrics } from "../lib/data/today";
import {
  getAccuracyScorecard,
  getInsightsOverview,
  getPlanAdherence,
  getStockoutTrend,
} from "../lib/data/insights";

/**
 * Insights against the seeded local database. The screen is a presentation of
 * numbers Today already owns, so the load-bearing assertions here are that it
 * agrees with Today exactly, that a member's payload carries no cost, and that
 * the accuracy card reads one specific BacktestRun row out of the several that
 * share a run date. Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

/** Marks the rows this suite writes so cleanup can't touch anything else. */
const PROBE_RUN = new Date("2031-03-03T00:00:00.000Z");

let seeded: SeedResult;

describe.skipIf(!runnable)("insights (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish must degrade to a no-op
    seeded = await seedDev();
    await runForecast(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.backtestRun.deleteMany({ where: { runDate: PROBE_RUN } });
    await prismaService.$disconnect();
  });

  it("reports exactly the stockout and dead-stock numbers Today reports", async () => {
    const [overview, today] = await Promise.all([
      getInsightsOverview(seeded.tenantId, { canViewCosts: true }),
      getTodayMetrics(seeded.tenantId, { canViewCosts: true }),
    ]);

    // The whole point of the single-loader design: these cannot drift.
    expect(overview.stockouts.skus).toBe(today.stockedOutProducts);
    expect(overview.stockouts.trackedProducts).toBe(today.trackedProducts);
    expect(overview.deadStock.skus).toBe(today.deadStock.skus);
    expect(overview.deadStock.costKes).toBe(today.deadStock.costKes);
    expect(overview.deadStock.windowDays).toBe(today.deadStock.windowDays);
  });

  it("lists empty shelves and never counts one as idle cash", async () => {
    const overview = await getInsightsOverview(seeded.tenantId, { canViewCosts: true });

    const stockedOut = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId, active: true, currentStock: { lte: 0 } },
      select: { id: true },
    });
    const outIds = new Set(stockedOut.map((p) => p.id));

    for (const row of overview.shelfRows) expect(outIds.has(row.productId)).toBe(true);
    // An empty shelf is a stockout, never "cash asleep".
    for (const row of overview.cashRows) {
      expect(outIds.has(row.productId)).toBe(false);
      expect(row.onHandUnits).toBeGreaterThan(0);
    }
    // Ranked by what they cost the shop.
    const missed = overview.shelfRows.map((r) => r.missedSalesKes);
    expect(missed).toEqual([...missed].sort((a, b) => b - a));
  });

  it("hands a money-blind member the same rows in the same order, without the money", async () => {
    const [owner, member] = await Promise.all([
      getInsightsOverview(seeded.tenantId, { canViewCosts: true }),
      getInsightsOverview(seeded.tenantId, { canViewCosts: false }),
    ]);

    expect(member.cashRows.map((r) => r.productId)).toEqual(owner.cashRows.map((r) => r.productId));
    expect(member.cashTotalKes).toBeNull();
    expect(member.deadStock.costKes).toBeNull();
    for (const row of member.cashRows) expect(row.cashKes).toBeNull();
    expect(owner.cashTotalKes).not.toBeNull();

    // Sales figures are not costs — a member still sees what an empty shelf costs in sales.
    expect(member.shelfRows).toEqual(owner.shelfRows);
  });

  it("reads the whole-shop accuracy row, not the per-class or challenger ones", async () => {
    const rows = [
      { abcClass: "ALL", method: "run_rate", saidUnits: 1240, happenedUnits: 1110, leans: "over" },
      { abcClass: "ALL", method: "recent_heavy", saidUnits: 999, happenedUnits: 111, leans: "under" },
      { abcClass: "A", method: "run_rate", saidUnits: 500, happenedUnits: 480, leans: "even" },
    ];
    await prismaService.backtestRun.createMany({
      data: rows.map((r) => ({
        tenantId: seeded.tenantId,
        runDate: PROBE_RUN,
        mae: 2,
        bias: 1,
        mape: 10,
        sampleSize: 12,
        tag: "walkforward",
        ...r,
      })),
    });

    const scorecard = await getAccuracyScorecard(seeded.tenantId);
    expect(scorecard.latest).not.toBeNull();
    // One check date must yield one reading, not one per class and method.
    expect(scorecard.latest!.saidUnits).toBe(1240);
    expect(scorecard.latest!.happenedUnits).toBe(1110);
    expect(scorecard.latest!.leans).toBe("over");

    // Error percentages and model names were rejected as unreadable; not fetching
    // them is what makes rendering one impossible rather than merely discouraged.
    expect(JSON.stringify(scorecard)).not.toMatch(/mae|mape|bias|run_rate|recent_heavy/);
  });

  it("ignores an accuracy row too old or too thin to mean anything", async () => {
    await prismaService.backtestRun.create({
      data: {
        tenantId: seeded.tenantId,
        runDate: PROBE_RUN,
        mae: 1,
        bias: 0,
        sampleSize: 0, // scored nothing
        tag: "walkforward",
        abcClass: "ALL",
        method: "run_rate",
        saidUnits: 7,
        happenedUnits: 7,
        leans: "even",
      },
    });
    const scorecard = await getAccuracyScorecard(seeded.tenantId);
    for (const check of scorecard.history) expect(check.sampleSize).toBeGreaterThan(0);
  });

  it("returns an honest empty shape for a tenant with no history at all", async () => {
    const probe = await prismaService.tenant.create({
      data: { name: "Insights Probe", slug: `insights-probe-${Date.now()}` },
    });
    try {
      const [overview, scorecard, adherence, trend] = await Promise.all([
        getInsightsOverview(probe.id, { canViewCosts: true }),
        getAccuracyScorecard(probe.id),
        getPlanAdherence(probe.id),
        getStockoutTrend(probe.id),
      ]);

      expect(overview.stockouts.trackedProducts).toBe(0);
      expect(overview.stockouts.ratePct).toBe(0); // not NaN
      expect(overview.shelfRows).toEqual([]);
      expect(scorecard.latest).toBeNull();
      expect(scorecard.firstSaleAt).toBeNull();
      expect(adherence.hasHistory).toBe(false);
      expect(adherence.askedProducts).toBe(0);
      expect(trend.weeks).toEqual([]);
      expect(trend.trackingSince).toBeNull();
    } finally {
      await prismaService.tenant.delete({ where: { id: probe.id } });
    }
  });

  it("counts an ask as acted on only once the forecast has asked for it", async () => {
    const adherence = await getPlanAdherence(seeded.tenantId);
    // The run just executed, so there are asks but no orders raised against them.
    expect(adherence.hasHistory).toBe(true);
    expect(adherence.askedProducts).toBeGreaterThan(0);
    expect(adherence.actedProducts).toBeLessThanOrEqual(adherence.askedProducts);
    expect(adherence.linesCompared).toBe(
      adherence.boughtLess + adherence.boughtAsAsked + adherence.boughtMore
    );
  });

  it("drops a stockout week that has too few nights recorded", async () => {
    const product = await prismaService.product.findFirst({
      where: { tenantId: seeded.tenantId, active: true },
      select: { id: true },
    });
    // Three nights inside one week — below the floor, so the week is not reported
    // rather than reported on a thin denominator.
    const base = Date.UTC(2031, 2, 3); // a Monday
    await prismaService.inventorySnapshot.createMany({
      data: [0, 1, 2].map((d) => ({
        tenantId: seeded.tenantId,
        productId: product!.id,
        date: new Date(base + d * 86_400_000),
        onHand: 0,
      })),
    });
    try {
      const trend = await getStockoutTrend(seeded.tenantId, { weeks: 520 });
      expect(trend.weeks.some((w) => w.weekStart.getTime() === base)).toBe(false);
      expect(trend.trackingSince).not.toBeNull();
    } finally {
      await prismaService.inventorySnapshot.deleteMany({
        where: { tenantId: seeded.tenantId, date: { gte: new Date(base) } },
      });
    }
  });
});
