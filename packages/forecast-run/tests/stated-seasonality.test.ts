import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../db/scripts/seed-dev";
import { runForecast } from "../src/run";

/**
 * Stated seasonality, end to end through a real run.
 *
 * The engine has taken a month multiplier since it was written, and that half is
 * unit-tested. What this holds is the half that has quietly failed five times in
 * this codebase: that the value actually travels from the row a shop writes,
 * through the run, into the number on the buy list. A feature that computes
 * correctly and is then discarded looks identical to one that works, right up
 * until someone checks.
 *
 * `MonthlyContext` is the table this is built on, and until now it had no reader
 * at all — every field on it was free text the forecast could not use.
 *
 * Skips without a local database.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

let seeded: SeedResult;
let tenantId: string;

/** The month the run's own horizon starts in — the one a multiplier has to
 *  land on to move today's numbers. */
function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Total units the run recommends across the shop. */
async function recommendedUnits(): Promise<number> {
  const rows = await prismaService.prediction.findMany({
    where: { tenantId },
    select: { recommendedQty: true },
  });
  return rows.reduce((sum, r) => sum + r.recommendedQty, 0);
}

/** Total 30-day demand the run forecast across the shop. */
async function forecastUnits(): Promise<number> {
  const rows = await prismaService.prediction.findMany({
    where: { tenantId },
    select: { finalForecast30d: true },
  });
  return rows.reduce((sum, r) => sum + r.finalForecast30d, 0);
}

describe.skipIf(!runnable)("stated seasonality reaches the buy list (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish degrades to a no-op
    seeded = await seedDev();
    tenantId = seeded.tenantId;
  }, 120_000);

  afterEach(async () => {
    await prismaService.monthlyContext.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    await prismaService.monthlyContext.deleteMany({ where: { tenantId } });
    await prismaService.$disconnect();
  });

  it("changes nothing when the shop has stated no month", async () => {
    // The default every existing workspace is on. If this ever fails, the
    // feature is not opt-in and every shop's numbers moved without being asked.
    await runForecast(tenantId);
    const baseline = await forecastUnits();

    await runForecast(tenantId);
    expect(await forecastUnits()).toBeCloseTo(baseline, 6);
  });

  it("orders more when the shop says the month is busier", async () => {
    await runForecast(tenantId);
    const baseline = await recommendedUnits();
    expect(baseline).toBeGreaterThan(0); // vacuity guard

    await prismaService.monthlyContext.create({
      data: { tenantId, month: currentMonthKey(), expectedMultiplier: 2 },
    });
    await runForecast(tenantId);

    expect(await recommendedUnits()).toBeGreaterThan(baseline);
  });

  it("orders less when the shop says the month is quieter", async () => {
    await runForecast(tenantId);
    const baseline = await forecastUnits();

    await prismaService.monthlyContext.create({
      data: { tenantId, month: currentMonthKey(), expectedMultiplier: 0.5 },
    });
    await runForecast(tenantId);

    expect(await forecastUnits()).toBeLessThan(baseline);
  });

  it("ignores a month row that states nothing", async () => {
    // MonthlyContext carries the shop's free-text notes too. A row with notes
    // and no multiplier must leave the forecast exactly where it was.
    await runForecast(tenantId);
    const baseline = await forecastUnits();

    await prismaService.monthlyContext.create({
      data: {
        tenantId,
        month: currentMonthKey(),
        seasonalExpectation: "Busy, I think",
        notes: "Nothing measurable stated",
      },
    });
    await runForecast(tenantId);

    expect(await forecastUnits()).toBeCloseTo(baseline, 6);
  });

  it("ignores a month the horizon never reaches", async () => {
    await runForecast(tenantId);
    const baseline = await forecastUnits();

    // Two years out: the 30-day horizon cannot touch it.
    const far = new Date();
    far.setUTCFullYear(far.getUTCFullYear() + 2);
    await prismaService.monthlyContext.create({
      data: { tenantId, month: far.toISOString().slice(0, 7), expectedMultiplier: 4 },
    });
    await runForecast(tenantId);

    expect(await forecastUnits()).toBeCloseTo(baseline, 6);
  });

  it("bounds a slipped decimal rather than ordering a hundred times over", async () => {
    await prismaService.monthlyContext.create({
      data: { tenantId, month: currentMonthKey(), expectedMultiplier: 999 },
    });
    await runForecast(tenantId);

    const rows = await prismaService.prediction.findMany({
      where: { tenantId },
      select: { finalForecast30d: true, recommendedQty: true },
    });
    for (const r of rows) {
      expect(Number.isFinite(r.finalForecast30d)).toBe(true);
      expect(r.recommendedQty).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.recommendedQty)).toBe(true);
    }
  }, 60_000);

  it("keeps one shop's stated month out of another's forecast", async () => {
    // MonthlyContext is tenant-scoped like everything else; a month stated by
    // one workspace must not move a neighbour's order quantities.
    const otherSlug = `seasonality-other-${Date.now()}`;
    const other = await prismaService.tenant.create({
      data: { name: "Seasonality Other", slug: otherSlug },
    });
    try {
      await prismaService.monthlyContext.create({
        data: { tenantId: other.id, month: currentMonthKey(), expectedMultiplier: 4 },
      });
      await runForecast(tenantId);
      const withNeighbour = await forecastUnits();

      await prismaService.monthlyContext.deleteMany({ where: { tenantId: other.id } });
      await runForecast(tenantId);

      expect(await forecastUnits()).toBeCloseTo(withNeighbour, 6);
    } finally {
      await prismaService.tenant.delete({ where: { id: other.id } });
    }
  }, 60_000);
});
