import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  DEAD_SKUS,
  STOCKOUT_SKUS,
  seedDev,
  type SeedResult,
} from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import {
  createOrdersForPredictions,
  getBuyList,
  splitByBudget,
  type BuyListRow,
} from "../lib/data/plan";

/**
 * Plan data module against the seeded local database: seed -> forecast ->
 * buy list / budget split / order creation. Expectations are recomputed
 * independently on the service client, so a wrong (or leaking) query shows up
 * as a mismatch. Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const URGENCY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

let seeded: SeedResult;

describe.skipIf(!runnable)("plan data (seeded local db)", () => {
  beforeAll(async () => {
    // Publish must degrade to a no-op without a broker configured.
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await runForecast(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("builds the buy list from the latest run with real costs and ordering", async () => {
    const buyList = await getBuyList(seeded.tenantId);
    expect(buyList).not.toBeNull();
    expect(buyList!.totalPredicted).toBe(seeded.productCount);

    const predictions = await prismaService.prediction.findMany({
      where: { tenantId: seeded.tenantId },
      include: { product: { include: { supplier: true } } },
    });
    const expectedIds = new Set(
      predictions.filter((p) => Math.round(p.recommendedQty) > 0).map((p) => p.id)
    );
    expect(new Set(buyList!.rows.map((r) => r.predictionId))).toEqual(expectedIds);
    expect(buyList!.rows.length).toBeGreaterThan(0);

    const bySku = new Map(predictions.map((p) => [p.product.sku, p]));
    for (const row of buyList!.rows) {
      const p = bySku.get(row.sku)!;
      expect(row.recommendedQty).toBe(Math.round(p.recommendedQty));
      expect(row.daysUntilStockout).toBe(p.daysUntilStockout);
      expect(row.urgency).toBe(p.urgency);
      expect(row.unitCostKes).toBe(p.product.costKes);
      expect(row.lineTotalKes).toBeCloseTo(row.recommendedQty * p.product.costKes, 5);
      expect(row.reasoning).toBe(p.reasoning);
      expect(row.supplierName).toBe(p.product.supplier?.name ?? null);
      // Deferral price recomputed straight from the stored engine output.
      const stockoutDays = Math.max(0, 30 - p.daysUntilStockout);
      expect(row.atRiskKes).toBe(
        Math.round((p.finalForecast30d / 30) * p.product.priceKes * stockoutDays)
      );
    }
    expect(buyList!.totalCostKes).toBeCloseTo(
      buyList!.rows.reduce((sum, r) => sum + r.lineTotalKes, 0),
      5
    );

    // Most urgent first: urgency rank, then imminence.
    for (let i = 1; i < buyList!.rows.length; i++) {
      const prev = buyList!.rows[i - 1]!;
      const curr = buyList!.rows[i]!;
      const rankDelta = URGENCY_RANK[curr.urgency]! - URGENCY_RANK[prev.urgency]!;
      expect(rankDelta).toBeGreaterThanOrEqual(0);
      if (rankDelta === 0) {
        expect(curr.daysUntilStockout).toBeGreaterThanOrEqual(prev.daysUntilStockout);
      }
    }

    // Stocked-out fast movers must demand an order today; dead SKUs stay off the list.
    for (const sku of STOCKOUT_SKUS) {
      const row = buyList!.rows.find((r) => r.sku === sku);
      expect(row, sku).toBeDefined();
      expect(row!.tier).toBe("order_today");
    }
    for (const sku of DEAD_SKUS) {
      expect(buyList!.rows.find((r) => r.sku === sku)).toBeUndefined();
    }
  });

  it("tiers every row by its last safe day to order (stockout minus lead)", async () => {
    const buyList = await getBuyList(seeded.tenantId);
    const products = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId },
      include: { supplier: true },
    });
    const bySku = new Map(products.map((p) => [p.sku, p]));

    for (const row of buyList!.rows) {
      const product = bySku.get(row.sku)!;
      const leadDays = product.leadTimeDays ?? product.supplier?.leadTimeAvgDays ?? 0;
      const daysLeft = row.daysUntilStockout - leadDays;
      expect(row.daysLeftToOrder).toBe(daysLeft);
      const expectedTier =
        row.urgency === "critical" || daysLeft <= 0
          ? "order_today"
          : daysLeft <= 7
            ? "this_week"
            : "can_wait";
      expect(row.tier, row.sku).toBe(expectedTier);
    }
  });

  it("gives every row a qty breakdown that lands on the shown number", async () => {
    const buyList = await getBuyList(seeded.tenantId);
    for (const row of buyList!.rows) {
      // The derived identity line always exists and always names the shown qty.
      expect(row.qtySummary).toContain(`+ ${row.recommendedQty} ordered`);
      expect(row.reasoning.length).toBeGreaterThan(0);
      // The exact mean-cover arithmetic only attaches when it reproduces the
      // stored number. Under default tenant config every class resolves to a
      // policy rule (calibrated/min-max), so explain is typically null — but
      // when present it must be exact.
      if (row.explain) {
        expect(row.explain.recommendedQty).toBe(row.recommendedQty);
        const { dailyForecast, coverDays, safetyStock, currentStock, onOrder } = row.explain;
        const total = Math.max(
          0,
          Math.ceil(dailyForecast * coverDays + safetyStock - currentStock - onOrder)
        );
        expect(total).toBe(row.recommendedQty);
      }
    }
  });

  it("splits the list against a budget: sums reconcile, criticals never wait", async () => {
    const buyList = await getBuyList(seeded.tenantId);
    const rows = buyList!.rows;

    // Everything seeded has sane unit economics, so nothing lands in checkCost.
    const full = splitByBudget(rows, buyList!.totalCostKes);
    expect(full.checkCost).toHaveLength(0);
    expect(full.deferred).toHaveLength(0);
    expect(full.funded).toHaveLength(rows.length);
    expect(full.fundedCostKes).toBeCloseTo(buyList!.totalCostKes, 5);
    expect(full.leftoverKes).toBeCloseTo(0, 5);

    const half = splitByBudget(rows, buyList!.totalCostKes / 2);
    expect(half.funded.length + half.deferred.length).toBe(rows.length);
    expect(half.fundedCostKes + half.deferredCostKes).toBeCloseTo(buyList!.totalCostKes, 5);
    expect(half.fundedCostKes).toBeCloseTo(
      half.funded.reduce((sum, r) => sum + r.lineTotalKes, 0),
      5
    );
    expect(half.deferredAtRiskKes).toBeCloseTo(
      half.deferred.reduce((sum, r) => sum + r.atRiskKes, 0),
      5
    );
    // No overlap between the splits.
    const fundedIds = new Set(half.funded.map((r) => r.predictionId));
    for (const row of half.deferred) expect(fundedIds.has(row.predictionId)).toBe(false);
    // Criticals are funded regardless of the cap.
    for (const row of rows.filter((r) => r.urgency === "critical")) {
      expect(fundedIds.has(row.predictionId), row.sku).toBe(true);
    }

    // Zero budget: only criticals survive, and their cost is the overflow.
    const zero = splitByBudget(rows, 0);
    const criticals = rows.filter((r) => r.urgency === "critical");
    expect(new Set(zero.funded.map((r) => r.predictionId))).toEqual(
      new Set(criticals.map((r) => r.predictionId))
    );
    expect(zero.overBudgetKes).toBeCloseTo(
      criticals.reduce((sum, r) => sum + r.lineTotalKes, 0),
      5
    );
  });

  it("creates pending Orders for ticked predictions and updates on re-add", async () => {
    const buyList = await getBuyList(seeded.tenantId);
    const ids = buyList!.rows.slice(0, 3).map((r) => r.predictionId);

    const first = await createOrdersForPredictions(seeded.tenantId, [...ids, "nonexistent-id"]);
    expect(first).toEqual({ created: 3, updated: 0, skipped: 1 });

    const orders = await prismaService.order.findMany({
      where: { tenantId: seeded.tenantId, predictionId: { in: ids } },
    });
    expect(orders).toHaveLength(3);
    for (const order of orders) {
      expect(order.status).toBe("pending");
      expect(order.orderedQty).toBeGreaterThanOrEqual(1);
      expect(order.productId).not.toBeNull();
      const row = buyList!.rows.find((r) => r.predictionId === order.predictionId)!;
      expect(order.orderedQty).toBe(row.recommendedQty);
      expect(order.productId).toBe(row.productId);
    }

    // Re-adding the same lines updates the pending rows instead of stacking.
    const second = await createOrdersForPredictions(seeded.tenantId, ids);
    expect(second).toEqual({ created: 0, updated: 3, skipped: 0 });
    const after = await prismaService.order.count({
      where: { tenantId: seeded.tenantId, predictionId: { in: ids } },
    });
    expect(after).toBe(3);
  });

  it("scopes everything to the tenant: foreign ids resolve to nothing", async () => {
    const probe = await prismaService.tenant.create({
      data: { name: "Plan Probe", slug: "plan-data-probe" },
    });
    try {
      expect(await getBuyList(probe.id)).toBeNull();

      // The victim tenant's prediction ids are invisible under the probe's scope.
      const victimIds = (
        await prismaService.prediction.findMany({
          where: { tenantId: seeded.tenantId },
          select: { id: true },
          take: 3,
        })
      ).map((p) => p.id);
      const result = await createOrdersForPredictions(probe.id, victimIds);
      expect(result).toEqual({ created: 0, updated: 0, skipped: 3 });
      expect(await prismaService.order.count({ where: { tenantId: probe.id } })).toBe(0);
    } finally {
      await prismaService.tenant.delete({ where: { id: probe.id } });
    }
  });
});

/** Pure allocator wrapper — no database needed. */
describe("splitByBudget (pure)", () => {
  let seq = 0;
  function mkRow(partial: Partial<BuyListRow>): BuyListRow {
    seq += 1;
    return {
      predictionId: `pred-${seq}`,
      productId: `prod-${seq}`,
      sku: `SKU-${seq}`,
      title: `Product ${seq}`,
      vendor: null,
      supplierName: null,
      onHandUnits: 10,
      onOrderUnits: 0,
      daysUntilStockout: 10,
      daysLeftToOrder: 5,
      urgency: "medium",
      tier: "this_week",
      recommendedQty: 10,
      unitCostKes: 100,
      lineTotalKes: 1000,
      priceKes: 200,
      reasoning: "test row",
      explain: null,
      qtySummary: "test summary",
      plannable: "ok",
      atRiskKes: 0,
      ...partial,
    };
  }

  it("routes broken-cost rows to checkCost, never into the split", () => {
    const good = mkRow({});
    const broken = mkRow({ plannable: "missing-cost", lineTotalKes: 0 });
    const split = splitByBudget([good, broken], 10_000);
    expect(split.checkCost.map((r) => r.predictionId)).toEqual([broken.predictionId]);
    expect(split.funded.map((r) => r.predictionId)).toEqual([good.predictionId]);
    expect(split.deferred).toHaveLength(0);
  });

  it("funds criticals past the cap and reports the overflow", () => {
    const critical = mkRow({ urgency: "critical", lineTotalKes: 5000 });
    const medium = mkRow({ lineTotalKes: 1000 });
    const split = splitByBudget([medium, critical], 1000);
    expect(split.funded.map((r) => r.predictionId)).toContain(critical.predictionId);
    expect(split.fundedCostKes).toBe(5000);
    expect(split.overBudgetKes).toBe(4000);
    expect(split.deferred.map((r) => r.predictionId)).toEqual([medium.predictionId]);
    expect(split.deferredCostKes).toBe(1000);
  });

  it("prefers the bigger revenue-at-risk within the same urgency", () => {
    const small = mkRow({ atRiskKes: 100, lineTotalKes: 800 });
    const big = mkRow({ atRiskKes: 9000, lineTotalKes: 800 });
    const split = splitByBudget([small, big], 800);
    expect(split.funded.map((r) => r.predictionId)).toEqual([big.predictionId]);
    expect(split.deferred.map((r) => r.predictionId)).toEqual([small.predictionId]);
    expect(split.deferredAtRiskKes).toBe(100);
    expect(split.leftoverKes).toBe(0);
  });
});
