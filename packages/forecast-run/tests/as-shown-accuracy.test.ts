import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../db/scripts/seed-dev";
import {
  recordAsShownAccuracy,
  leansOf,
  AS_SHOWN_TAG,
  AS_SHOWN_HORIZON_DAYS,
} from "../src/as-shown-accuracy";

/**
 * Scoring the advice the shop was actually given.
 *
 * The walk-forward trail replays the forecast with today's engine, so it moves
 * whenever the engine changes — including its account of months already sold.
 * These rows score the stored ForecastRecommendation instead, which is the number
 * the shop saw on the day, and is therefore the only trail that can answer "was
 * what we told you right?".
 *
 * Skips without a local database.
 */

const DAY_MS = 86_400_000;
const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

let seeded: SeedResult;
let tenantId: string;
let productId: string;

/** A run day whose 30-day horizon has fully elapsed. */
function elapsedRunDay(daysAgo = AS_SHOWN_HORIZON_DAYS + 5): Date {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function writeRecommendation(runDate: Date, said: number, abcClass = "A") {
  await prismaService.forecastRecommendation.create({
    data: {
      tenantId,
      productId,
      runDate,
      recommendedQty: said,
      finalForecast30d: said,
      daysUntilStockout: 10,
      urgency: "medium",
      onHandAtRun: 0,
      abcClass,
    },
  });
}

async function writeSale(date: Date, quantity: number) {
  await prismaService.salesHistory.create({
    data: { tenantId, productId, date, quantity, revenueKes: quantity * 100 },
  });
}

async function allRows() {
  return prismaService.backtestRun.findMany({
    where: { tenantId, tag: AS_SHOWN_TAG },
    orderBy: { runDate: "asc" },
  });
}

describe.skipIf(!runnable)("as-shown accuracy (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    tenantId = seeded.tenantId;
    // A product of its own, with no sales history. Reusing a seeded product puts
    // the seed's own sales inside the scoring window, so "what actually sold"
    // counts demand this test never wrote.
    const product = await prismaService.product.create({
      data: {
        tenantId,
        sku: "AS-SHOWN-FIXTURE",
        title: "As-shown accuracy fixture",
        abcCategory: "A",
      },
      select: { id: true },
    });
    productId = product.id;
  }, 120_000);

  afterEach(async () => {
    await prismaService.backtestRun.deleteMany({ where: { tenantId, tag: AS_SHOWN_TAG } });
    await prismaService.forecastRecommendation.deleteMany({ where: { tenantId } });
    await prismaService.salesHistory.deleteMany({ where: { tenantId, productId } });
  });

  afterAll(async () => {
    await prismaService.backtestRun.deleteMany({ where: { tenantId, tag: AS_SHOWN_TAG } });
    await prismaService.forecastRecommendation.deleteMany({ where: { tenantId } });
    await prismaService.salesHistory.deleteMany({ where: { tenantId, productId } });
    await prismaService.product.delete({ where: { id: productId } });
    await prismaService.$disconnect();
  });

  it("scores what was said against what actually sold", async () => {
    const runDay = elapsedRunDay();
    await writeRecommendation(runDay, 100);
    // 60 units inside the horizon; the shop was told 100.
    await writeSale(new Date(runDay.getTime() + 3 * DAY_MS), 40);
    await writeSale(new Date(runDay.getTime() + 20 * DAY_MS), 20);

    const outcome = await recordAsShownAccuracy(tenantId);
    expect(outcome.runsScored).toBe(1);

    const all = (await allRows()).find((r) => r.abcClass === "ALL");
    expect(all, "no ALL rollup written").toBeDefined();
    expect(all!.saidUnits).toBeCloseTo(100, 6);
    expect(all!.happenedUnits).toBeCloseTo(60, 6);
    expect(all!.leans).toBe("over");
  });

  it("ignores sales outside the horizon it described", async () => {
    // The stored number is a 30-day forecast. Counting day 31 against it would
    // credit the forecast with demand it never claimed.
    const runDay = elapsedRunDay(90);
    await writeRecommendation(runDay, 50);
    await writeSale(new Date(runDay.getTime() - 2 * DAY_MS), 999); // before
    await writeSale(new Date(runDay.getTime() + 10 * DAY_MS), 50); // inside
    await writeSale(new Date(runDay.getTime() + 45 * DAY_MS), 999); // after

    await recordAsShownAccuracy(tenantId);
    const all = (await allRows()).find((r) => r.abcClass === "ALL");
    expect(all!.happenedUnits).toBeCloseTo(50, 6);
    expect(all!.leans).toBe("even");
  });

  it("gives each run day only the sales inside its own window", async () => {
    // With one run day the sales query's own bounds already exclude everything
    // outside the horizon, so a per-day window check looks redundant. It is not:
    // two run days share one query spanning both, and without the per-day check
    // every day is credited with every other day's demand.
    const older = elapsedRunDay(90); // window covers 90..60 days ago
    const newer = elapsedRunDay(40); // window covers 40..10 days ago
    await writeRecommendation(older, 100);
    await writeRecommendation(newer, 100);
    await writeSale(new Date(Date.now() - 70 * DAY_MS), 30); // older's window only
    await writeSale(new Date(Date.now() - 20 * DAY_MS), 70); // newer's window only

    await recordAsShownAccuracy(tenantId);
    const rollups = (await allRows()).filter((r) => r.abcClass === "ALL");
    expect(rollups).toHaveLength(2);
    const [first, second] = rollups; // ordered by runDate asc
    expect(first!.happenedUnits).toBeCloseTo(30, 6);
    expect(second!.happenedUnits).toBeCloseTo(70, 6);
  });

  it("will not score a horizon that has not finished yet", async () => {
    // Ten days in, twenty still to come: scoring now reports a shortfall that has
    // not happened. This is the failure that would make every recent run look
    // wildly over-forecast.
    const recent = new Date(Date.now() - 10 * DAY_MS);
    recent.setUTCHours(0, 0, 0, 0);
    await writeRecommendation(recent, 100);

    const outcome = await recordAsShownAccuracy(tenantId);
    expect(outcome.runsScored).toBe(0);
    expect(await allRows()).toHaveLength(0);
  });

  it("does not double-count a run day it has already scored", async () => {
    const runDay = elapsedRunDay();
    await writeRecommendation(runDay, 100);
    await writeSale(new Date(runDay.getTime() + 5 * DAY_MS), 60);

    const first = await recordAsShownAccuracy(tenantId);
    expect(first.rowsWritten).toBeGreaterThan(0);

    const second = await recordAsShownAccuracy(tenantId);
    expect(second.runsScored).toBe(0);
    expect(second.rowsWritten).toBe(0);

    const rollups = (await allRows()).filter((r) => r.abcClass === "ALL");
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.happenedUnits).toBeCloseTo(60, 6);
  });

  it("keeps its rows out of the walk-forward trail", async () => {
    // The two trails answer different questions and must never be averaged. The
    // scorecard pins tag, class and method, so a stray tag would silently join
    // the shop's accuracy history.
    const runDay = elapsedRunDay();
    await writeRecommendation(runDay, 10);
    await recordAsShownAccuracy(tenantId);

    const walkforward = await prismaService.backtestRun.findMany({
      where: { tenantId, tag: "walkforward", runDate: runDay },
    });
    expect(walkforward).toHaveLength(0);
    expect((await allRows()).every((r) => r.tag === AS_SHOWN_TAG)).toBe(true);
  });

  it("reports a shortfall as under, not over", async () => {
    const runDay = elapsedRunDay(70);
    await writeRecommendation(runDay, 20);
    await writeSale(new Date(runDay.getTime() + 2 * DAY_MS), 80);

    await recordAsShownAccuracy(tenantId);
    const all = (await allRows()).find((r) => r.abcClass === "ALL");
    expect(all!.leans).toBe("under");
    expect(all!.happenedUnits).toBeCloseTo(80, 6);
  });
});

describe("leans wording", () => {
  it("calls a 5% miss even, either way", () => {
    // Supplier pack sizes and rounding make exactness meaningless; the dead band
    // is what stops the shop being told it was wrong about nothing.
    expect(leansOf(102, 100)).toBe("even");
    expect(leansOf(98, 100)).toBe("even");
    expect(leansOf(120, 100)).toBe("over");
    expect(leansOf(80, 100)).toBe("under");
  });

  it("says over when nothing sold at all", () => {
    // Zero actual has no percentage, but "we said 40 and you sold none" is the
    // most important miss on the list, not an undefined one.
    expect(leansOf(40, 0)).toBe("over");
    expect(leansOf(0, 0)).toBe("even");
  });
});
