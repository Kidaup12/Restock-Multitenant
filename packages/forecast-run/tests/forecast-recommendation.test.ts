import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaForTenant, prismaService } from "@wezesha/db";
import { DEAD_SKUS, seedDev, type SeedResult } from "../../db/scripts/seed-dev";
import { runForecast } from "../src/run";

/**
 * The recommendation history against a seeded local database. Prediction is
 * replaced wholesale by every run; these rows are the record that outlives it,
 * so the suite proves exactly that: they appear, a same-day re-run does not
 * duplicate or rewrite them, they SURVIVE the next run that wipes Prediction,
 * anything past the retention window is pruned, and RLS confines them to their
 * tenant. Skips without a local database.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

const DAY_MS = 86_400_000;
const OTHER_SLUG = "fc-history-other";

let seeded: SeedResult;
let tenantId: string;
let otherTenantId: string;

/** UTC midnight of today — the day-key the run writes. */
function runDay(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

describe.skipIf(!runnable)("forecast recommendation history (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish degrades to a no-op
    seeded = await seedDev();
    tenantId = seeded.tenantId;

    await prismaService.tenant.deleteMany({ where: { slug: OTHER_SLUG } });
    const other = await prismaService.tenant.create({
      data: { name: "FC History Other", slug: OTHER_SLUG },
    });
    otherTenantId = other.id;
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: OTHER_SLUG } });
    await prismaService.$disconnect();
  });

  it("writes a history row for every recommendation worth keeping", async () => {
    await runForecast(tenantId);

    const rows = await prismaService.forecastRecommendation.findMany({ where: { tenantId } });
    expect(rows.length).toBeGreaterThan(0);

    // Eligibility: a real ask, or an urgent shortfall the run answered with zero.
    for (const row of rows) {
      expect(row.recommendedQty > 0 || ["critical", "high"].includes(row.urgency)).toBe(true);
      expect(row.runDate.toISOString()).toBe(runDay().toISOString());
    }

    // Quiet, well-stocked dead stock carries no adherence signal — never written.
    const dead = await prismaService.product.findMany({
      where: { tenantId, sku: { in: DEAD_SKUS } },
      select: { id: true },
    });
    const deadRows = rows.filter((r) => dead.some((d) => d.id === r.productId));
    expect(deadRows).toEqual([]);
  });

  it("snapshots the numbers the run made the call on, on-hand included", async () => {
    await runForecast(tenantId);

    const rows = await prismaService.forecastRecommendation.findMany({ where: { tenantId } });
    const products = await prismaService.product.findMany({
      where: { tenantId },
      select: { id: true, currentStock: true, abcCategory: true },
    });
    const stockById = new Map(products.map((p) => [p.id, p.currentStock]));

    for (const row of rows) {
      expect(row.onHandAtRun).toBe(stockById.get(row.productId));
      expect(["sure", "fairly_sure", "guessing", null]).toContain(row.confidenceWord);
    }
    // ABC is assigned across the catalogue, so the class travels with the row.
    expect(rows.some((r) => r.abcClass != null)).toBe(true);
    for (const row of rows) expect(["A", "B", "C", null]).toContain(row.abcClass);

    // Same run, same numbers as the live plan.
    const predictions = await prismaService.prediction.findMany({ where: { tenantId } });
    const predictionById = new Map(predictions.map((p) => [p.productId, p]));
    for (const row of rows) {
      const prediction = predictionById.get(row.productId);
      expect(prediction).toBeDefined();
      expect(row.recommendedQty).toBe(prediction!.recommendedQty);
      expect(row.daysUntilStockout).toBe(prediction!.daysUntilStockout);
    }
  });

  it("a same-day re-run is idempotent — no duplicate key, no rewritten history", async () => {
    await runForecast(tenantId);
    const before = await prismaService.forecastRecommendation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    });

    await runForecast(tenantId);
    await runForecast(tenantId);

    const after = await prismaService.forecastRecommendation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  it("history survives the next run — the run that wipes every Prediction row", async () => {
    await runForecast(tenantId);
    const historyIds = (
      await prismaService.forecastRecommendation.findMany({
        where: { tenantId },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((r) => r.id);
    const predictionIds = (
      await prismaService.prediction.findMany({ where: { tenantId }, select: { id: true } })
    ).map((p) => p.id);
    expect(historyIds.length).toBeGreaterThan(0);

    await runForecast(tenantId);

    // Prediction was replaced wholesale...
    const survivingPredictions = await prismaService.prediction.findMany({
      where: { tenantId, id: { in: predictionIds } },
      select: { id: true },
    });
    expect(survivingPredictions).toEqual([]);

    // ...the history was not.
    const survivingHistory = await prismaService.forecastRecommendation.findMany({
      where: { tenantId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(survivingHistory.map((r) => r.id)).toEqual(historyIds);
  });

  it("prunes past the retention window and keeps everything inside it", async () => {
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId },
      select: { id: true },
    });
    const base = runDay().getTime();
    const ancient = new Date(base - 500 * DAY_MS);
    const recent = new Date(base - 399 * DAY_MS);

    for (const date of [ancient, recent]) {
      await prismaService.forecastRecommendation.create({
        data: {
          tenantId,
          productId: product.id,
          runDate: date,
          recommendedQty: 7,
          finalForecast30d: 20,
          daysUntilStockout: 5,
          urgency: "high",
          onHandAtRun: 3,
        },
      });
    }

    await runForecast(tenantId);

    const dates = (
      await prismaService.forecastRecommendation.findMany({
        where: { tenantId, productId: product.id },
        select: { runDate: true },
      })
    ).map((r) => r.runDate.toISOString());
    expect(dates).not.toContain(ancient.toISOString());
    expect(dates).toContain(recent.toISOString());
  });

  it("is tenant-scoped: another workspace reads none of it", async () => {
    await runForecast(tenantId);

    const mine = await prismaForTenant(tenantId).forecastRecommendation.findMany();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.tenantId === tenantId)).toBe(true);

    const theirs = await prismaForTenant(otherTenantId).forecastRecommendation.findMany({
      where: { tenantId },
    });
    expect(theirs).toEqual([]);
  });
});
