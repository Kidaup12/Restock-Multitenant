import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  DEAD_SKUS,
  STOCKOUT_SKUS,
  seedDev,
  type SeedResult,
} from "../../../packages/db/scripts/seed-dev";
import { getReorderNeeded, getTodayMetrics } from "../lib/data/today";
import { getRevenueByMonth, getSalesSeries, getTopProducts } from "../lib/data/sales";
import { getStockCatalogue, getStockByLocation } from "../lib/data/stock";

/**
 * Data-module suite against the seeded local database. The modules run on the
 * RLS-enforced tenant client; expectations are computed independently on the
 * service client, so a wrong (or leaking) query shows up as a mismatch.
 * Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const DAY_MS = 86_400_000;

let seeded: SeedResult;

describe.skipIf(!runnable)("data modules (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("getTodayMetrics matches independently computed sums", async () => {
    const metrics = await getTodayMetrics(seeded.tenantId, { canViewCosts: true });

    const since30 = new Date(Date.now() - 30 * DAY_MS);
    const expected = await prismaService.salesHistory.aggregate({
      _sum: { revenueKes: true },
      where: { tenantId: seeded.tenantId, date: { gte: since30 } },
    });
    expect(metrics.revenue30dKes).toBeCloseTo(expected._sum.revenueKes ?? 0, 5);
    expect(metrics.revenue30dKes).toBeGreaterThan(0);
    expect(metrics.trackedProducts).toBe(seeded.productCount);
    expect(metrics.stockedOutProducts).toBe(STOCKOUT_SKUS.length);

    // Dead stock: exactly the seeded dead SKUs, at on-hand x cost.
    const deadProducts = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId, sku: { in: DEAD_SKUS } },
      select: { id: true, costKes: true },
    });
    const levels = await prismaService.inventoryLevel.groupBy({
      by: ["productId"],
      where: { tenantId: seeded.tenantId, productId: { in: deadProducts.map((p) => p.id) } },
      _sum: { onHand: true },
    });
    const onHand = new Map(levels.map((l) => [l.productId, l._sum.onHand ?? 0]));
    const expectedDeadCost = deadProducts.reduce(
      (sum, p) => sum + (onHand.get(p.id) ?? 0) * p.costKes,
      0
    );
    expect(metrics.deadStock.skus).toBe(DEAD_SKUS.length);
    expect(metrics.deadStock.costKes).toBeCloseTo(expectedDeadCost, 5);
    expect(expectedDeadCost).toBeGreaterThan(0);
  });

  it("getSalesSeries returns ascending per-day totals that sum to the 30d revenue", async () => {
    const [series, metrics] = await Promise.all([
      getSalesSeries(seeded.tenantId, 30),
      getTodayMetrics(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(series.length).toBeGreaterThanOrEqual(25);
    expect(series.length).toBeLessThanOrEqual(30);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.date > series[i - 1]!.date).toBe(true);
    }
    const total = series.reduce((sum, s) => sum + s.revenueKes, 0);
    expect(total).toBeCloseTo(metrics.revenue30dKes, 5);
  });

  it("getRevenueByMonth covers the requested months and matches the raw sum", async () => {
    const months = await getRevenueByMonth(seeded.tenantId, 4);
    expect(months).toHaveLength(4);
    expect(months.every((m) => /^\d{4}-\d{2}$/.test(m.month))).toBe(true);

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
    const expected = await prismaService.salesHistory.aggregate({
      _sum: { revenueKes: true },
      where: { tenantId: seeded.tenantId, date: { gte: start } },
    });
    const total = months.reduce((sum, m) => sum + m.revenueKes, 0);
    expect(total).toBeCloseTo(expected._sum.revenueKes ?? 0, 5);
  });

  it("getTopProducts ranks by revenue with a consistent run rate", async () => {
    const top = await getTopProducts(seeded.tenantId, { days: 30, limit: 10 });
    expect(top).toHaveLength(10);
    for (let i = 1; i < top.length; i++) {
      expect(top[i]!.revenueKes).toBeLessThanOrEqual(top[i - 1]!.revenueKes);
    }
    for (const row of top) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.runRatePerDay).toBeCloseTo(row.unitsSold / 30, 8);
    }
  });

  it("getStockCatalogue reflects InventoryLevel sums and pre-forecast nulls", async () => {
    const rows = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
    expect(rows).toHaveLength(seeded.productCount);

    const levels = await prismaService.inventoryLevel.groupBy({
      by: ["productId"],
      where: { tenantId: seeded.tenantId },
      _sum: { onHand: true },
    });
    const onHand = new Map(levels.map((l) => [l.productId, l._sum.onHand ?? 0]));
    for (const row of rows) {
      expect(row.onHandUnits).toBe(onHand.get(row.productId) ?? 0);
      expect(row.stockValueKes).toBeCloseTo(row.onHandUnits * row.costKes!, 5);
      // Fresh seed wipes predictions — cover is unknown until a forecast runs.
      expect(row.daysCover).toBeNull();
    }
    for (const sku of STOCKOUT_SKUS) {
      expect(rows.find((r) => r.sku === sku)?.onHandUnits).toBe(0);
    }
  });

  it("getStockByLocation reconciles with the catalogue totals", async () => {
    const [locations, catalogue] = await Promise.all([
      getStockByLocation(seeded.tenantId, { canViewCosts: true }),
      getStockCatalogue(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(locations).toHaveLength(2);
    expect(locations[0]!.isPrimary).toBe(true);

    const locationUnits = locations.reduce((sum, l) => sum + l.unitsOnHand, 0);
    const catalogueUnits = catalogue.reduce((sum, r) => sum + r.onHandUnits, 0);
    expect(locationUnits).toBe(catalogueUnits);

    for (const location of locations) {
      expect(location.skuCount).toBe(location.lines.length);
      for (const line of location.lines) expect(line.onHand).toBeGreaterThan(0);
    }
  });

  it("returns empty results for a tenant with no data (tenant-scoped clients)", async () => {
    const empty = await prismaService.tenant.create({
      data: { name: "Empty Probe", slug: "screens-data-empty-probe" },
    });
    try {
      const metrics = await getTodayMetrics(empty.id, { canViewCosts: true });
      expect(metrics.revenue30dKes).toBe(0);
      expect(metrics.trackedProducts).toBe(0);
      expect(metrics.deadStock.costKes).toBe(0);
      expect(await getStockCatalogue(empty.id, { canViewCosts: true })).toHaveLength(0);
      expect(await getSalesSeries(empty.id, 30)).toHaveLength(0);
      expect(await getReorderNeeded(empty.id, { canViewCosts: true })).toBeNull();
    } finally {
      await prismaService.tenant.delete({ where: { id: empty.id } });
    }
  });
});
