import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { daysOfStockRemaining, type SalesPoint } from "@wezesha/forecast";
import {
  DEAD_SKUS,
  STOCKOUT_SKUS,
  seedDev,
  type SeedResult,
} from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "@/lib/forecast-run/run";
import { getCatalogueMetrics, runRate, abcForCatalogue, moneyAtRest } from "@/lib/metrics";
import { deriveFacetOptions } from "@/lib/facets";
import { getTodayMetrics } from "@/lib/data/today";
import { getStockCatalogue } from "@/lib/data/stock";
import { getTopProducts } from "@/lib/data/sales";
import { getBuyList } from "@/lib/data/plan";

/**
 * The one-engine proof (spec "Metrics & metadata" — one calculation everywhere).
 * Against the seeded amara-beauty catalogue, every screen must agree on the two
 * metrics that used to diverge:
 *   - sellable on-hand (Today / Stock / Plan)  → all read Product.currentStock
 *   - run rate (Sales / Stock / forecast)      → all read the blended engine rate
 * and cover / ABC / money-at-rest come from the shared metric module.
 *
 * Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);
const DAY_MS = 86_400_000;

let seeded: SeedResult;

describe.skipIf(!runnable)("shared metric contract (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    await runForecast(seeded.tenantId); // populate predictions so the buy list exists
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("sellable on-hand is IDENTICAL across the metric engine, Today, Stock and Plan", async () => {
    const tenantId = seeded.tenantId;
    const asOf = new Date();

    const [metrics, catalogue, buyList, products, allLevels] = await Promise.all([
      getCatalogueMetrics(tenantId, { asOf }),
      getStockCatalogue(tenantId, { canViewCosts: true }),
      getBuyList(tenantId, { canViewCosts: true }),
      prismaService.product.findMany({
        where: { tenantId, active: true },
        select: { id: true, currentStock: true },
      }),
      prismaService.inventoryLevel.aggregate({ _sum: { onHand: true }, where: { tenantId } }),
    ]);

    const currentStock = new Map(products.map((p) => [p.id, p.currentStock]));
    const catalogueOnHand = new Map(catalogue.map((r) => [r.productId, r.onHandUnits]));

    // The single source: metric engine === Product.currentStock === Stock catalogue.
    for (const p of products) {
      expect(metrics.get(p.id)!.sellableOnHand).toBe(p.currentStock);
      expect(catalogueOnHand.get(p.id)).toBe(p.currentStock);
    }

    // Plan buy list reads the same on-hand for every line it emits — active AND
    // held-back (excluded). The exclusion split changes which bucket a product
    // lands in, never the shared on-hand it reads.
    expect(buyList).not.toBeNull();
    for (const row of [...buyList!.rows, ...buyList!.excluded]) {
      expect(row.onHandUnits).toBe(currentStock.get(row.productId));
      expect(row.onHandUnits).toBe(catalogueOnHand.get(row.productId));
    }

    // The fix, quantified: sellable total is the Sells-only rollup and is
    // strictly below the all-locations total (warehouse/Holds stock excluded) —
    // the old today.ts summed all locations and disagreed with Stock.
    const sellableTotal = products.reduce((s, p) => s + p.currentStock, 0);
    const catalogueTotal = catalogue.reduce((s, r) => s + r.onHandUnits, 0);
    expect(catalogueTotal).toBe(sellableTotal);
    expect(sellableTotal).toBeLessThan(allLevels._sum.onHand ?? 0);
  });

  it("run rate is IDENTICAL across the metric engine, Sales and an independent computation", async () => {
    const tenantId = seeded.tenantId;
    const asOf = new Date();

    const metrics = await getCatalogueMetrics(tenantId, { asOf });
    const top = await getTopProducts(tenantId, { days: 30, limit: 10 });

    // Independent run rate from the same 365d history, at the same asOf.
    const since = new Date(asOf.getTime() - 365 * DAY_MS);
    const sales = await prismaService.salesHistory.findMany({
      where: { tenantId, date: { gte: since } },
      select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
    });
    const historyByProduct = new Map<string, SalesPoint[]>();
    for (const row of sales) {
      const list = historyByProduct.get(row.productId) ?? [];
      list.push(row);
      historyByProduct.set(row.productId, list);
    }

    for (const p of metrics.values()) {
      const expected = runRate(historyByProduct.get(p.productId) ?? [], asOf);
      expect(p.runRate).toBe(expected); // metric engine === independent engine
    }
    // Sales screen shows the same blended number (its own asOf is ~now).
    for (const row of top) {
      expect(row.runRate).toBeCloseTo(metrics.get(row.productId)!.runRate, 2);
    }
  });

  it("cover is the one live formula: stock ÷ run rate, everywhere", async () => {
    const tenantId = seeded.tenantId;
    const metrics = await getCatalogueMetrics(tenantId);
    const catalogue = await getStockCatalogue(tenantId, { canViewCosts: true });

    for (const p of metrics.values()) {
      expect(p.coverDays).toBe(daysOfStockRemaining(p.sellableOnHand, p.runRate));
    }
    for (const row of catalogue) {
      const m = metrics.get(row.productId)!;
      expect(row.daysCover).toBe(m.runRate > 1e-4 ? m.coverDays : null);
    }
  });

  it("ABC comes from the forecast primitives and spreads across the catalogue", async () => {
    const tenantId = seeded.tenantId;
    const asOf = new Date();
    const [metrics, catalogue, products, sales] = await Promise.all([
      getCatalogueMetrics(tenantId, { asOf }),
      getStockCatalogue(tenantId, { canViewCosts: true }),
      prismaService.product.findMany({
        where: { tenantId, active: true },
        select: { id: true, priceKes: true, shopifyCreatedAt: true },
      }),
      prismaService.salesHistory.findMany({
        where: { tenantId, date: { gte: new Date(asOf.getTime() - 365 * DAY_MS) } },
        select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
      }),
    ]);

    const historyByProduct = new Map<string, SalesPoint[]>();
    for (const row of sales) {
      const list = historyByProduct.get(row.productId) ?? [];
      list.push(row);
      historyByProduct.set(row.productId, list);
    }
    const expected = abcForCatalogue(
      products.map((p) => ({
        id: p.id,
        history: historyByProduct.get(p.id) ?? [],
        priceKes: p.priceKes,
        createdAt: p.shopifyCreatedAt,
      })),
      asOf
    );

    const catalogueAbc = new Map(catalogue.map((r) => [r.productId, r.abc]));
    for (const p of products) {
      expect(metrics.get(p.id)!.abc).toBe(expected.get(p.id) ?? null);
      expect(catalogueAbc.get(p.id)).toBe(expected.get(p.id) ?? null);
    }
    // A real catalogue produces a spread, not one bucket.
    const classes = new Set([...metrics.values()].map((m) => m.abc));
    expect(classes.has("A")).toBe(true);
    expect(classes.has("B")).toBe(true);
    expect(classes.has("C")).toBe(true);
  });

  it("Today reads the same engine: stocked-out, dead stock and money-at-rest", async () => {
    const tenantId = seeded.tenantId;
    const [metrics, today, deadProducts] = await Promise.all([
      getCatalogueMetrics(tenantId),
      getTodayMetrics(tenantId, { canViewCosts: true }),
      prismaService.product.findMany({
        where: { tenantId, sku: { in: DEAD_SKUS } },
        select: { costKes: true, currentStock: true },
      }),
    ]);

    const stockedOutByEngine = [...metrics.values()].filter((m) => m.sellableOnHand <= 0).length;
    expect(today.stockedOutProducts).toBe(stockedOutByEngine);
    expect(today.stockedOutProducts).toBe(STOCKOUT_SKUS.length);

    expect(today.deadStock.skus).toBe(DEAD_SKUS.length);
    expect(today.deadStock.windowDays).toBe(90); // spec §11 default
    const expectedDead = deadProducts.reduce((s, p) => s + moneyAtRest(p.costKes, p.currentStock), 0);
    expect(today.deadStock.costKes).toBeCloseTo(expectedDead, 5);
  });

  it("derives facet options from what the seeded catalogue actually contains", async () => {
    const tenantId = seeded.tenantId;
    const catalogue = await getStockCatalogue(tenantId, { canViewCosts: true });
    const options = deriveFacetOptions(catalogue.map((r) => r.facet));

    // Brand facet = distinct vendors present, counts summing to the catalogue.
    const distinctVendors = new Set(catalogue.map((r) => r.vendor).filter(Boolean));
    expect(options.brand).toHaveLength(distinctVendors.size);
    expect(options.brand.reduce((s, o) => s + o.count, 0)).toBe(catalogue.length);

    // Owner categories seeded from productType: Hair / Skin / Makeup.
    expect(options.category.map((o) => o.value).sort()).toEqual(["Hair", "Makeup", "Skin"]);

    // Speed bands derived from supplier lead times (10/21/42d) → Regional + Import,
    // never Local (nothing ≤7d in the seed).
    const bands = options.speedBand.map((o) => o.value);
    expect(bands).toContain("regional");
    expect(bands).toContain("import");
    expect(bands).not.toContain("local");

    // Health flags include the seeded dead stock, and supplierGroup stays empty
    // (that column belongs to the suppliers stream).
    const deadOption = options.health.find((o) => o.value === "dead");
    expect(deadOption?.count).toBeGreaterThanOrEqual(DEAD_SKUS.length);
    expect(options.supplierGroup).toEqual([]);

    // ABC is a facet too — A/B/C for ranked products, plus a 'none' bucket for
    // the dormant dead SKUs (no class), always listed last.
    expect(options.abc.map((o) => o.value)).toEqual(expect.arrayContaining(["A", "B", "C"]));
    expect(options.abc[options.abc.length - 1]!.value).toBe("__none__");
  });
});
