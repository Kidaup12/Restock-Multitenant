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
import { roleOf, sellableUnits } from "@wezesha/db";
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

    // Dead stock: exactly the seeded dead SKUs, at SELLABLE on-hand x cost —
    // the single source is Product.currentStock (Sells-only), not all locations.
    const deadProducts = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId, sku: { in: DEAD_SKUS } },
      select: { id: true, costKes: true, currentStock: true },
    });
    const expectedDeadCost = deadProducts.reduce(
      (sum, p) => sum + p.currentStock * p.costKes,
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
      // Run rate is the blended engine rate (recency-weighted, all-channel), not
      // the naive units/window that used to live here.
      expect(Number.isFinite(row.runRate)).toBe(true);
      expect(row.runRate).toBeGreaterThan(0);
    }
  });

  it("getStockCatalogue reports SELLS on-hand, holds warehouse stock separately", async () => {
    const rows = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
    expect(rows).toHaveLength(seeded.productCount);

    // Independently split each product's SELLABLE units by its location's role.
    // Sellable means available — what is left once units already promised to a
    // customer are set aside — not everything physically standing there.
    const [levels, locations] = await Promise.all([
      prismaService.inventoryLevel.findMany({
        where: { tenantId: seeded.tenantId },
        select: { productId: true, locationId: true, available: true, onHand: true },
      }),
      prismaService.location.findMany({
        where: { tenantId: seeded.tenantId },
        select: { id: true, locationType: true },
      }),
    ]);
    const roleByLocation = new Map(locations.map((l) => [l.id, roleOf(l)]));
    const sells = new Map<string, number>();
    const holds = new Map<string, number>();
    for (const l of levels) {
      const role = roleByLocation.get(l.locationId);
      const units = sellableUnits(l);
      if (role === "sells") sells.set(l.productId, (sells.get(l.productId) ?? 0) + units);
      else if (role === "holds") holds.set(l.productId, (holds.get(l.productId) ?? 0) + units);
    }

    for (const row of rows) {
      expect(row.onHandUnits).toBe(sells.get(row.productId) ?? 0);
      expect(row.warehouseUnits).toBe(holds.get(row.productId) ?? 0);
      expect(row.stockValueKes).toBeCloseTo(
        (row.onHandUnits + row.warehouseUnits) * row.costKes!,
        5
      );
      // Cover is recomputed LIVE from current stock at the run rate — no forecast
      // run required. Null only when there is no run rate to divide by.
      expect(row.daysCover).toBe(
        row.runRate > 1e-4 ? Math.floor(row.onHandUnits / row.runRate) : null
      );
    }
    for (const sku of STOCKOUT_SKUS) {
      expect(rows.find((r) => r.sku === sku)?.onHandUnits).toBe(0);
    }
  });

  it("sellable on-hand EXCLUDES the warehouse (a wrong role would corrupt cover)", async () => {
    const rows = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });

    const levels = await prismaService.inventoryLevel.findMany({
      where: { tenantId: seeded.tenantId },
      select: { productId: true, available: true, onHand: true },
    });
    const allLocations = new Map<string, number>();
    for (const l of levels) {
      allLocations.set(l.productId, (allLocations.get(l.productId) ?? 0) + sellableUnits(l));
    }

    // Some product has stock in the warehouse (Holds) — its sellable on-hand
    // must be strictly below its all-locations total, i.e. the warehouse units
    // dropped out of the cover math.
    const withWarehouse = rows.filter((r) => r.warehouseUnits > 0);
    expect(withWarehouse.length).toBeGreaterThan(0);
    for (const row of withWarehouse) {
      const all = allLocations.get(row.productId) ?? 0;
      expect(row.onHandUnits).toBeLessThan(all);
      expect(row.onHandUnits + row.warehouseUnits).toBe(all);
    }

    // Tenant-wide: sellable on-hand is less than total on-hand by exactly the
    // warehouse holdings.
    const sellable = rows.reduce((s, r) => s + r.onHandUnits, 0);
    const warehouse = rows.reduce((s, r) => s + r.warehouseUnits, 0);
    const total = [...allLocations.values()].reduce((s, v) => s + v, 0);
    expect(warehouse).toBeGreaterThan(0);
    expect(sellable).toBe(total - warehouse);
  });

  it("getStockByLocation labels roles and reconciles with the catalogue by role", async () => {
    const [locations, catalogue] = await Promise.all([
      getStockByLocation(seeded.tenantId, { canViewCosts: true }),
      getStockCatalogue(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(locations).toHaveLength(2);
    expect(locations[0]!.isPrimary).toBe(true);

    const shop = locations.find((l) => l.role === "sells")!;
    const warehouse = locations.find((l) => l.role === "holds")!;
    expect(shop.showCover).toBe(true);
    expect(warehouse.showCover).toBe(false); // warehouses hold, they don't sell

    // Sells-location units reconcile with catalogue sellable on-hand; holds with warehouse units.
    const sellsUnits = locations.filter((l) => l.role === "sells").reduce((s, l) => s + l.unitsOnHand, 0);
    const holdsUnits = locations.filter((l) => l.role === "holds").reduce((s, l) => s + l.unitsOnHand, 0);
    expect(sellsUnits).toBe(catalogue.reduce((s, r) => s + r.onHandUnits, 0));
    expect(holdsUnits).toBe(catalogue.reduce((s, r) => s + r.warehouseUnits, 0));

    for (const location of locations) {
      expect(location.skuCount).toBe(location.lines.length);
      for (const line of location.lines) expect(line.onHand).not.toBe(0);
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
