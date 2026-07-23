import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  DEAD_SKUS,
  STOCKOUT_SKUS,
  seedDev,
  type SeedResult,
} from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { getReorderNeeded } from "../lib/data/today";

/**
 * Round trip: seed -> run the forecast -> Prediction rows exist with a sane
 * urgency spread and feed the reorder query. Runs with no REDIS_URL so the
 * realtime publish exercises its no-op path. Skips without a local database.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

let seeded: SeedResult;

describe.skipIf(!runnable)("forecast run (seeded local db)", () => {
  beforeAll(async () => {
    // Publish must degrade to a no-op without a broker configured.
    delete process.env.REDIS_URL;
    seeded = await seedDev();
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("writes one prediction per active product under a shared run id", async () => {
    const result = await runForecast(seeded.tenantId);
    expect(result.created).toBe(seeded.productCount);
    expect(result.forecastRunId).toMatch(/[0-9a-f-]{36}/);

    const predictions = await prismaService.prediction.findMany({
      where: { tenantId: seeded.tenantId },
      include: { product: { select: { sku: true } } },
    });
    expect(predictions).toHaveLength(seeded.productCount);
    expect(new Set(predictions.map((p) => p.forecastRunId))).toEqual(
      new Set([result.forecastRunId])
    );

    // Urgency spreads across the seeded variety instead of collapsing to one bucket.
    const urgencies = new Set(predictions.map((p) => p.urgency));
    expect(urgencies.size).toBeGreaterThanOrEqual(2);
    for (const p of predictions) {
      expect(["critical", "high", "medium", "low"]).toContain(p.urgency);
      expect(p.finalForecast30d).toBeGreaterThanOrEqual(0);
      expect(p.daysUntilStockout).toBeGreaterThanOrEqual(0);
      expect(() => JSON.parse(p.signals)).not.toThrow();
    }

    // Fast sellers sitting at zero stock must scream.
    for (const sku of STOCKOUT_SKUS) {
      const p = predictions.find((row) => row.product.sku === sku)!;
      expect(p.daysUntilStockout).toBe(0);
      expect(["critical", "high"]).toContain(p.urgency);
    }
    // Dead SKUs get no reorder recommendation.
    for (const sku of DEAD_SKUS) {
      const p = predictions.find((row) => row.product.sku === sku)!;
      expect(p.recommendedQty).toBe(0);
    }
  });

  it("replaces the previous run instead of stacking rows", async () => {
    const first = await prismaService.prediction.findFirst({
      where: { tenantId: seeded.tenantId },
      select: { forecastRunId: true },
    });
    const rerun = await runForecast(seeded.tenantId);
    expect(rerun.forecastRunId).not.toBe(first?.forecastRunId);

    const predictions = await prismaService.prediction.findMany({
      where: { tenantId: seeded.tenantId },
      select: { forecastRunId: true },
    });
    expect(predictions).toHaveLength(seeded.productCount);
    expect(new Set(predictions.map((p) => p.forecastRunId))).toEqual(
      new Set([rerun.forecastRunId])
    );
  });

  it("feeds the reorder query: most urgent first, order costs attached", async () => {
    const reorder = await getReorderNeeded(seeded.tenantId);
    expect(reorder).not.toBeNull();
    expect(reorder!.totalPredicted).toBe(seeded.productCount);
    expect(reorder!.rows.length).toBeGreaterThan(0);

    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < reorder!.rows.length; i++) {
      expect(rank[reorder!.rows[i]!.urgency]!).toBeGreaterThanOrEqual(
        rank[reorder!.rows[i - 1]!.urgency]!
      );
    }
    for (const row of reorder!.rows) {
      if (row.recommendedQty > 0) {
        expect(row.orderCostKes).toBeGreaterThan(0);
      }
    }
  });
});
