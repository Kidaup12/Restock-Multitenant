import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaForTenant, prismaService } from "@wezesha/db";
import { applyMoq } from "../lib/po/po-math";
import {
  ASSUMED_LEAD_DAYS,
  NO_STOCKOUT_DAYS,
  coverDaysFor,
  leadDaysFor,
  recommendedQty,
} from "@wezesha/forecast";
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
  redactBuyList,
  removePlanOverride,
  splitByBudget,
  upsertPlanOverride,
  type BuyList,
  type BuyListRow,
} from "../lib/data/plan";
import {
  EMPTY_SCOPE,
  filterBuyListRows,
  leadBandFor,
  type ScopeSelection,
} from "../app/(shell)/plan/scope-bar";
import { NONE_VALUE } from "../lib/facets/types";

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

  it("counts our own sent POs as on order, not just Shopify's incoming", async () => {
    // The nightly run already sized against outstanding POs; this screen read
    // Product.onOrder alone. Between sending a PO and the store recording the
    // delivery, the owner saw "On order: —" for stock they had already bought,
    // and the what-if re-sizer recommended those units a second time.
    //
    // The seed has no purchase orders at all, so the fixture IS the test — an
    // assertion made against the seed as-is passes whatever the code does.
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0];
    expect(target, "need at least one buy-list row").toBeTruthy();

    const product = await prismaService.product.findUniqueOrThrow({
      where: { id: target!.productId },
      select: { id: true, sku: true, title: true, onOrder: true },
    });
    expect(target!.onOrderUnits).toBe(product.onOrder); // today's behaviour

    // Outstanding is set STRICTLY ABOVE whatever Shopify reports, so MAX must
    // resolve to the PO. Sized off the live value rather than assuming zero —
    // every seeded product already has something inbound.
    const outstanding = product.onOrder + 25;
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId: seeded.tenantId,
        poNumber: `PO-INBOUND-${Date.now()}`,
        status: "sent",
        sentAt: new Date(),
        lines: {
          create: {
            tenantId: seeded.tenantId,
            productId: product.id,
            sku: product.sku,
            title: product.title,
            quantity: outstanding + 15,
            receivedQty: 15, // partially received, so the remainder is what counts
            unitCostKes: 100,
            lineTotalKes: 100 * (outstanding + 15),
          },
        },
      },
    });

    try {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      const row = [...after!.rows, ...after!.excluded].find(
        (r) => r.productId === product.id
      );
      expect(row, "the product must still be on the list somewhere").toBeTruthy();
      expect(row!.onOrderUnits).toBe(outstanding);
      expect(row!.onOrderUnits).toBeGreaterThan(product.onOrder); // it actually moved
    } finally {
      await prismaService.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: po.id } });
      await prismaService.purchaseOrder.delete({ where: { id: po.id } });
    }
  });

  it("prices a supplier minimum into the plan, not just into the purchase order", async () => {
    // #18. The floor was applied when the PO was written and nowhere else, so a
    // plan showing KES 1.08M of buying wrote KES 1.24M of orders. The owner
    // budgeting against the first number was short by the difference.
    const supplier = await prismaService.supplier.findFirst({
      where: { tenantId: seeded.tenantId, deletedAt: null },
      select: { id: true, moq: true },
    });
    expect(supplier).not.toBeNull();
    const original = supplier!.moq;

    try {
      await prismaService.supplier.update({ where: { id: supplier!.id }, data: { moq: 48 } });
      const list = await getBuyList(seeded.tenantId, { canViewCosts: true });
      const floored = list!.rows.filter(
        (r) => r.moq === 48 && r.recommendedQty > 0 && r.recommendedQty < 48
      );
      // If nothing is under the floor the test proves nothing — say so loudly
      // rather than passing on an empty set.
      expect(floored.length).toBeGreaterThan(0);

      for (const row of floored) {
        expect(row.orderQty).toBe(48);
        expect(row.lineTotalKes).toBeCloseTo(48 * row.unitCostKes!, 5);
        // And the engine's own number survives, for the MOQ note and analytics.
        expect(row.recommendedQty).toBeLessThan(48);
      }

      // The headline the owner budgets against moves with it.
      const summed = list!.rows.reduce((s, r) => s + (r.lineTotalKes ?? 0), 0);
      expect(list!.totalCostKes).toBeCloseTo(summed, 5);
    } finally {
      await prismaService.supplier.update({ where: { id: supplier!.id }, data: { moq: original } });
    }
  });

  it("builds the buy list from the latest run with real costs and ordering", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(buyList).not.toBeNull();
    expect(buyList!.totalPredicted).toBe(seeded.productCount);

    const predictions = await prismaService.prediction.findMany({
      where: { tenantId: seeded.tenantId },
      include: { product: { include: { supplier: true } } },
    });
    // EVERY prediction, not only the ones sized above zero. A zero-quantity row
    // used to be filtered out before the split and appear nowhere at all, so the
    // owner had no way to find out why a product they expected wasn't listed.
    const expectedIds = new Set(predictions.map((p) => p.id));
    // The exclusion split holds some products off the active list (already on the
    // way / bad cost / too slow / nothing to buy) but never drops them: active ∪
    // excluded is exactly every prediction the run made, each appearing once.
    const activeIds = buyList!.rows.map((r) => r.predictionId);
    const excludedIds = buyList!.excluded.map((r) => r.predictionId);
    expect(new Set([...activeIds, ...excludedIds])).toEqual(expectedIds);
    expect(activeIds.length + excludedIds.length).toBe(expectedIds.size); // no overlap
    expect(buyList!.rows.length).toBeGreaterThan(0);

    const bySku = new Map(predictions.map((p) => [p.product.sku, p]));

    // Independent trailing-30d revenue sum, same window as the data layer.
    const revSince = new Date(Date.now() - 30 * 86_400_000);
    const revAgg = await prismaService.salesHistory.groupBy({
      by: ["productId"],
      where: { tenantId: seeded.tenantId, date: { gte: revSince } },
      _sum: { revenueKes: true },
    });
    const revByProduct = new Map(revAgg.map((g) => [g.productId, g._sum.revenueKes ?? 0]));

    // The one-engine contract holds for every sized row — active OR held back:
    // its qty is the persisted prediction, never re-derived. The split only moves
    // the bucket, so prove the fields across active ∪ excluded.
    for (const row of [...buyList!.rows, ...buyList!.excluded]) {
      const p = bySku.get(row.sku)!;
      expect(row.recommendedQty).toBe(Math.round(p.recommendedQty));
      // "No stockout in sight" is a sentinel, resolved to null so no screen can
      // print 999 as a day count. Zero-quantity rows reach this loop now, and
      // they are exactly the ones that carry it.
      expect(row.daysUntilStockout).toBe(
        p.daysUntilStockout >= NO_STOCKOUT_DAYS ? null : p.daysUntilStockout
      );
      expect(row.urgency).toBe(p.urgency);
      expect(row.unitCostKes).toBe(p.product.costKes);
      // Priced off what will be ORDERED, not what was recommended. The two are
      // the same until a supplier has a minimum, and that difference is exactly
      // what used to make the plan cheaper than the purchase orders it became.
      expect(row.lineTotalKes).toBeCloseTo(row.orderQty * p.product.costKes, 5);
      expect(row.orderQty).toBeGreaterThanOrEqual(row.recommendedQty);
      expect(row.reasoning).toBe(p.reasoning);
      expect(row.supplierName).toBe(p.product.supplier?.name ?? null);
      // Deferral price recomputed straight from the stored engine output.
      const stockoutDays = Math.max(0, 30 - p.daysUntilStockout);
      expect(row.atRiskKes).toBe(
        Math.round((p.finalForecast30d / 30) * p.product.priceKes * stockoutDays)
      );

      // Richer planning columns (added, existing computations unchanged).
      expect(row.abc).toBe(p.product.abcCategory);
      // Owner category rides through unredacted — a scope-bar facet, not money.
      expect(row.category).toBe(p.product.customCategory);
      expect(row.moq).toBe(p.product.supplier?.moq ?? 1);
      const leadDays = p.product.leadTimeDays ?? p.product.supplier?.leadTimeAvgDays ?? ASSUMED_LEAD_DAYS;
      expect(row.leadDays).toBe(leadDays);
      // Run/day is the run's OWN rate — layer 1, before the promo lift and the
      // cap — read back from the prediction, never re-derived. The sized
      // forecast (finalForecast30d) answers a different question and belongs to
      // the quantity, not to the pace.
      expect(row.runRatePerDay).toBeCloseTo(Math.round((p.layer1Forecast30d / 30) * 10) / 10, 5);
      expect(row.orderByDate.getTime()).toBe(
        buyList!.runDate.getTime() + row.daysLeftToOrder * 86_400_000
      );
      expect(row.revenue30dKes).toBeCloseTo(revByProduct.get(row.productId) ?? 0, 5);
    }
    expect(buyList!.totalCostKes).toBeCloseTo(
      buyList!.rows.reduce((sum, r) => sum + r.lineTotalKes!, 0),
      5
    );

    // Bestsellers first, then most urgent, then imminence. Urgency is only
    // non-decreasing WITHIN a class now — across classes it deliberately is not,
    // which is the whole point of leading with class A.
    const abcRank = (abc: string | null) => ({ A: 0, B: 1, C: 2 })[abc ?? ""] ?? 3;
    for (let i = 1; i < buyList!.rows.length; i++) {
      const prev = buyList!.rows[i - 1]!;
      const curr = buyList!.rows[i]!;
      const classDelta = abcRank(curr.abc) - abcRank(prev.abc);
      expect(classDelta).toBeGreaterThanOrEqual(0);
      if (classDelta > 0) continue;

      const rankDelta = URGENCY_RANK[curr.urgency]! - URGENCY_RANK[prev.urgency]!;
      expect(rankDelta).toBeGreaterThanOrEqual(0);
      if (rankDelta === 0) {
        // "No stockout in sight" (null) sorts last, so rank it as infinitely far off.
        const rank = (d: number | null) => d ?? Number.POSITIVE_INFINITY;
        expect(rank(curr.daysUntilStockout)).toBeGreaterThanOrEqual(
          rank(prev.daysUntilStockout)
        );
      }
    }

    // Stocked-out fast movers must demand an order today; dead SKUs stay off the list.
    for (const sku of STOCKOUT_SKUS) {
      const row = buyList!.rows.find((r) => r.sku === sku);
      expect(row, sku).toBeDefined();
      expect(row!.tier).toBe("order_today");
    }
    for (const sku of DEAD_SKUS) {
      // Dead SKUs size to zero, so they stay off the ACTIVE list — but they are
      // no longer silently gone. They surface under `excluded` with the reason
      // they aren't being bought, which is what the owner came to find out.
      expect(buyList!.rows.find((r) => r.sku === sku)).toBeUndefined();
      const held = buyList!.excluded.find((r) => r.sku === sku);
      expect(held, sku).toBeDefined();
      expect(held!.recommendedQty).toBe(0);
      expect(["covered", "too-new", "already-ordered"]).toContain(held!.reason);
    }
  });

  it("persists the class the run worked from, and leads the list with it", async () => {
    // The run has always computed ABC and used it for service levels and
    // ordering policy, then thrown it away — so Product.abcCategory was null for
    // every product ever written, and anything reading the stored column saw an
    // unclassified catalogue. Without this the class-first ordering is inert.
    const classified = await prismaService.product.groupBy({
      by: ["abcCategory"],
      where: { tenantId: seeded.tenantId },
      _count: { _all: true },
    });
    const classes = classified.filter((c) => c.abcCategory !== null).map((c) => c.abcCategory);
    expect(classes.sort()).toEqual(["A", "B", "C"]);

    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const rows = buyList!.rows;
    const ranks = rows.map((r) => ({ A: 0, B: 1, C: 2 })[r.abc ?? ""] ?? 3);
    // Non-decreasing: every A before every B before every C.
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(rows[0]!.abc).toBe("A");
  });

  it("holds a product with an open order off the active list, tagged already-ordered", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const order = await prismaService.order.create({
      data: {
        tenantId: seeded.tenantId,
        status: "pending",
        productId: target.productId,
        orderedQty: 5,
        stockAtOrder: 0,
      },
    });
    try {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      // Dropped from the active list...
      expect(after!.rows.find((r) => r.productId === target.productId)).toBeUndefined();
      // ...surfaced under excluded, tagged, with the engine qty still riding it.
      const held = after!.excluded.find((r) => r.productId === target.productId);
      expect(held, target.sku).toBeDefined();
      expect(held!.reason).toBe("already-ordered");
      expect(held!.recommendedQty).toBe(target.recommendedQty);
    } finally {
      await prismaService.order.delete({ where: { id: order.id } });
    }
  });

  it("keeps a draft-PO product on the active list with a double-order warning", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId: seeded.tenantId,
        poNumber: "PO-DRAFT-TEST",
        status: "draft",
        lines: {
          create: {
            tenantId: seeded.tenantId,
            productId: target.productId,
            sku: target.sku,
            title: target.title,
            quantity: target.recommendedQty,
            unitCostKes: target.unitCostKes!,
            lineTotalKes: target.lineTotalKes!,
          },
        },
      },
    });
    try {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      const row = after!.rows.find((r) => r.productId === target.productId);
      // A draft PO isn't placed yet, so the row stays active...
      expect(row, target.sku).toBeDefined();
      // ...but carries the warn, and never lands in excluded.
      expect(row!.doubleOrderWarn).toBe(true);
      expect(after!.excluded.find((r) => r.productId === target.productId)).toBeUndefined();
    } finally {
      await prismaService.purchaseOrder.delete({ where: { id: po.id } });
    }
  });

  /**
   * The shape `createPoFromOrders` actually writes, which the line-only test
   * above never built: creating a PO flips the queue rows to "ordered" in the
   * same transaction that writes the PO as "draft". Keying "already on the way"
   * off the Order status alone therefore dropped the product, and the
   * double-order warning could never fire for the one case it was written for.
   *
   * Production carried two of these on one workspace — a class-A product at zero
   * stock, held off the buy list for a fortnight by a draft nobody had sent and,
   * the supplier having no email address, nobody could send.
   */
  async function withPoFor(
    target: { productId: string; sku: string; title: string; recommendedQty: number; unitCostKes: number | null; lineTotalKes: number | null },
    status: string,
    run: () => Promise<void>
  ) {
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId: seeded.tenantId,
        poNumber: `PO-${status.toUpperCase()}-TEST`,
        status,
        ...(status === "draft" ? {} : { sentAt: new Date() }),
        lines: {
          create: {
            tenantId: seeded.tenantId,
            productId: target.productId,
            sku: target.sku,
            title: target.title,
            quantity: target.recommendedQty,
            unitCostKes: target.unitCostKes!,
            lineTotalKes: target.lineTotalKes!,
          },
        },
      },
    });
    const order = await prismaService.order.create({
      data: {
        tenantId: seeded.tenantId,
        status: "ordered",
        productId: target.productId,
        orderedQty: target.recommendedQty,
        orderedAt: new Date(),
        purchaseOrderId: po.id,
      },
    });
    try {
      await run();
    } finally {
      await prismaService.order.delete({ where: { id: order.id } });
      await prismaService.purchaseOrder.delete({ where: { id: po.id } });
    }
  }

  it("keeps a product on the active list when its purchase order is still a draft", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    await withPoFor(target, "draft", async () => {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      const row = after!.rows.find((r) => r.productId === target.productId);
      expect(row, target.sku).toBeDefined();
      expect(row!.doubleOrderWarn).toBe(true);
      expect(after!.excluded.find((r) => r.productId === target.productId)).toBeUndefined();
    });
  });

  /** The control the fix must not break: a PO that really went out still takes
   *  the product off the list. Flip the status here and the test above is the
   *  one that fails. */
  it("drops a product whose purchase order has been sent", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    await withPoFor(target, "sent", async () => {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      expect(after!.rows.find((r) => r.productId === target.productId)).toBeUndefined();
      const held = after!.excluded.find((r) => r.productId === target.productId);
      expect(held, target.sku).toBeDefined();
      expect(held!.reason).toBe("already-ordered");
    });
  });

  it("excludes a product with no usable cost as unplannable", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const original = await prismaService.product.findUnique({
      where: { id: target.productId },
      select: { costKes: true },
    });
    // No unit cost on file → the planner can't reason about the line.
    await prismaService.product.update({
      where: { id: target.productId },
      data: { costKes: 0 },
    });
    try {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      expect(after!.rows.find((r) => r.productId === target.productId)).toBeUndefined();
      const held = after!.excluded.find((r) => r.productId === target.productId);
      expect(held, target.sku).toBeDefined();
      expect(held!.reason).toBe("unplannable");
      expect(held!.plannable).toBe("missing-cost");
    } finally {
      await prismaService.product.update({
        where: { id: target.productId },
        data: { costKes: original!.costKes },
      });
    }
  });

  it("puts a held-back product on the list when the owner orders it anyway", async () => {
    // The gap this closes. A product the run sized to nothing is held back, and
    // an override is the owner saying they know something the run does not — a
    // promotion nobody declared, a supplier about to close. The override used to
    // be read AFTER the list was split, so it changed the row's quantity while
    // leaving it in the held-back group: a number nobody could order, on exactly
    // the products the feature exists for.
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const held = before!.excluded.find((r) => r.reason !== "unplannable");
    expect(held, "nothing was held back to override").toBeDefined();
    expect(before!.rows.some((r) => r.productId === held!.productId)).toBe(false);

    await upsertPlanOverride(seeded.tenantId, {
      productId: held!.productId,
      qty: 9,
      createdByUserId: null,
      createdByName: null,
    });
    try {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      const now = after!.rows.find((r) => r.productId === held!.productId);
      expect(now, "the override did not move it onto the list").toBeDefined();
      expect(now!.overriddenQty).toBe(9);
      // And it is gone from the held-back side — not listed in both.
      expect(after!.excluded.some((r) => r.productId === held!.productId)).toBe(false);
    } finally {
      await removePlanOverride(seeded.tenantId, held!.productId);
    }
  });

  it("orders a slow mover the owner insisted on, but never one already on its way", async () => {
    // Half a fix is its own bug. Moving the product out of the sized-to-nothing
    // group only to have the slow-mover gate catch it left the owner clicking
    // "order anyway", setting a quantity, and watching it hop to a different
    // held-back group — which reads as nothing happening. "Sells too slowly" is
    // a judgement an override overrules; stock already on its way is a fact it
    // must not.
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const original = await prismaService.prediction.findUnique({
      where: { id: target.predictionId },
      select: { urgency: true, finalForecast30d: true },
    });
    // The slow-mover shape, forced onto the persisted prediction the same way the
    // gate's own test does: 0.2 units a day with plenty of cover.
    await prismaService.prediction.update({
      where: { id: target.predictionId },
      data: { urgency: "low", finalForecast30d: 6 },
    });
    try {
      const held = await getBuyList(seeded.tenantId, { canViewCosts: true });
      expect(
        held!.excluded.find((r) => r.productId === target.productId)?.reason,
        "the slow-mover gate did not fire, so there is nothing to overrule"
      ).toBe("slow-mover");

      await upsertPlanOverride(seeded.tenantId, {
        productId: target.productId,
        qty: 5,
        createdByUserId: null,
        createdByName: null,
      });
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      expect(
        after!.rows.some((r) => r.productId === target.productId),
        "a slow mover the owner insisted on stayed held back"
      ).toBe(true);
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
      await prismaService.prediction.update({
        where: { id: target.predictionId },
        data: { urgency: original!.urgency, finalForecast30d: original!.finalForecast30d },
      });
    }
  });

  it("never lets an override defeat the double-order guard", async () => {
    // The boundary of the rule above. Stock already on its way is a fact, not a
    // judgement, so no quantity the owner types may order it twice.
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const order = await prismaService.order.create({
      data: {
        tenantId: seeded.tenantId,
        status: "pending",
        productId: target.productId,
        orderedQty: 5,
        stockAtOrder: 0,
      },
    });
    await upsertPlanOverride(seeded.tenantId, {
      productId: target.productId,
      qty: 5,
      createdByUserId: null,
      createdByName: null,
    });
    try {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      expect(after!.rows.some((r) => r.productId === target.productId)).toBe(false);
      expect(after!.excluded.find((r) => r.productId === target.productId)?.reason).toBe(
        "already-ordered"
      );
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
      await prismaService.order.delete({ where: { id: order.id } });
    }
  });

  it("hands a product back to the run when the override is cleared", async () => {
    // The reverse, so the override is a loan rather than a one-way door.
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const held = before!.excluded.find((r) => r.reason !== "unplannable")!;

    await upsertPlanOverride(seeded.tenantId, {
      productId: held.productId,
      qty: 4,
      createdByUserId: null,
      createdByName: null,
    });
    await removePlanOverride(seeded.tenantId, held.productId);

    const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(after!.rows.some((r) => r.productId === held.productId)).toBe(false);
    expect(after!.excluded.some((r) => r.productId === held.productId)).toBe(true);
  });

  it("excludes a slow mover: plenty of cover (low urgency) and a low run rate", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const original = await prismaService.prediction.findUnique({
      where: { id: target.predictionId },
      select: { urgency: true, finalForecast30d: true },
    });
    // Force the slow-mover shape on the persisted prediction: 0.2 units/day and
    // plenty of cover. The recommended qty is untouched, so it still wants > 0.
    await prismaService.prediction.update({
      where: { id: target.predictionId },
      data: { urgency: "low", finalForecast30d: 6 },
    });
    try {
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      expect(after!.rows.find((r) => r.productId === target.productId)).toBeUndefined();
      const held = after!.excluded.find((r) => r.productId === target.productId);
      expect(held, target.sku).toBeDefined();
      expect(held!.reason).toBe("slow-mover");
    } finally {
      await prismaService.prediction.update({
        where: { id: target.predictionId },
        data: { urgency: original!.urgency, finalForecast30d: original!.finalForecast30d },
      });
    }
  });

  it("tiers every row by its last safe day to order (stockout minus lead)", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const products = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId },
      include: { supplier: true },
    });
    const bySku = new Map(products.map((p) => [p.sku, p]));

    for (const row of buyList!.rows) {
      const product = bySku.get(row.sku)!;
      const leadDays = product.leadTimeDays ?? product.supplier?.leadTimeAvgDays ?? ASSUMED_LEAD_DAYS;
      // Every seeded row sells, so each has a real cover to subtract the lead from.
      expect(row.daysUntilStockout, row.sku).not.toBeNull();
      const daysLeft = row.daysUntilStockout! - leadDays;
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

  it("carries the run's trust columns into every row it builds", async () => {
    // The columns had been written every night since the trust layer shipped and
    // read by nothing: the select omitted them, so they arrived `undefined` and
    // no component could have shown them. A render test proves a chip draws when
    // handed a prop; only this proves the prop is ever populated.
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const rows = [...buyList!.rows, ...buyList!.excluded];
    const stored = new Map(
      (await prismaService.prediction.findMany({ where: { tenantId: seeded.tenantId } })).map(
        (p) => [p.id, p]
      )
    );

    for (const row of rows) {
      const p = stored.get(row.predictionId)!;
      expect(row.confidence, row.sku).toBe(p.confidenceWord);
      expect(row.coldStart, row.sku).toBe(p.coldStart);
    }

    // Vacuity guards: the assertions above pass trivially if every value is null.
    expect(rows.some((r) => r.confidence !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.confidence)).size).toBeGreaterThan(1);
  });

  it("explains a policy-driven quantity instead of leaving it blank", async () => {
    // The old read-time recomputation could only redo the mean-cover branch, so
    // it returned null for every min/max row — and min/max is what class C
    // defaults to, i.e. most of the catalogue. The run's own breakdown covers it.
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const rows = [...buyList!.rows, ...buyList!.excluded];
    const minMaxIds = new Set(
      (
        await prismaService.prediction.findMany({
          where: { tenantId: seeded.tenantId, regime: "min_max" },
          select: { id: true },
        })
      ).map((p) => p.id)
    );
    const minMaxRows = rows.filter((r) => minMaxIds.has(r.predictionId));
    expect(minMaxRows.length).toBeGreaterThan(0); // vacuity guard
    const explained = minMaxRows.filter((r) => r.explain !== null);
    expect(explained.length).toBeGreaterThan(0);
    for (const row of explained) {
      expect(row.explain!.summary.length).toBeGreaterThan(0);
      expect(row.explain!.recommendedQty).toBe(row.recommendedQty);
    }
  });

  it("re-explains a what-if instead of shipping the plan's own breakdown", async () => {
    // A re-size at exactly the item's own cover reproduces the persisted
    // quantity, so an equality check alone would let the stored breakdown pass
    // while describing a different horizon. The horizon has to be the one asked for.
    const WANTED = 90; // clear of every natural cover in the seed (14/17/28/49)
    const plan = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const naturalCover = new Map(
      plan!.rows.filter((r) => r.explain).map((r) => [r.predictionId, r.explain!.coverDays])
    );
    expect(naturalCover.size).toBeGreaterThan(0);
    // Nothing here plans 45 days ahead by itself, so the horizon is a fingerprint:
    // if any row still shows its own cover, the stored breakdown was shipped.
    expect([...naturalCover.values()].every((c) => c < WANTED)).toBe(true);

    const resized = await getBuyList(seeded.tenantId, {
      canViewCosts: true,
      coverDays: WANTED,
    });
    const explained = resized!.rows.filter((r) => r.explain !== null && r.overriddenQty == null);
    expect(explained.length).toBeGreaterThan(0);
    for (const row of explained) {
      expect(row.explain!.recommendedQty, row.sku).toBe(row.recommendedQty);
      expect(row.explain!.coverDays, row.sku).toBe(Math.max(WANTED, row.leadDays));
    }
  });

  it("resolves a borrowed proxy title tenant-scoped, and never leaks the id", async () => {
    const [own, other] = await Promise.all([
      prismaService.product.findFirst({ where: { tenantId: seeded.tenantId } }),
      prismaService.product.findFirst({ where: { tenantId: { not: seeded.tenantId } } }),
    ]);
    const target = await prismaService.prediction.findFirst({
      where: { tenantId: seeded.tenantId },
    });
    const restore = {
      coldStart: target!.coldStart,
      borrowedFromProductId: target!.borrowedFromProductId,
    };
    try {
      const borrowed = async (proxyId: string | null) => {
        await prismaService.prediction.update({
          where: { id: target!.id },
          data: { coldStart: "borrowed", borrowedFromProductId: proxyId },
        });
        const list = await getBuyList(seeded.tenantId, { canViewCosts: true });
        return [...list!.rows, ...list!.excluded].find((r) => r.predictionId === target!.id)!;
      };

      expect((await borrowed(own!.id)).borrowedFromTitle).toBe(own!.title);
      // A proxy that has since been deleted — there is no FK to stop this.
      expect((await borrowed("prod-that-never-existed")).borrowedFromTitle).toBeNull();
      // Another workspace's product resolves to nothing: RLS scopes the lookup,
      // so the id can't be used to probe for products outside this tenant.
      if (other) expect((await borrowed(other.id)).borrowedFromTitle).toBeNull();
    } finally {
      await prismaService.prediction.update({ where: { id: target!.id }, data: restore });
    }
  });

  it("gives every row a qty breakdown that lands on the shown number", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    for (const row of buyList!.rows) {
      // The derived identity line always exists and always names the shown qty.
      expect(row.qtySummary).toContain(`+ ${row.recommendedQty} ordered`);
      expect(row.reasoning.length).toBeGreaterThan(0);
      // The breakdown is now the RUN's own, read back from explainParts rather
      // than recomputed — so it attaches to calibrated and min/max rows too,
      // which a read-time mean-cover recomputation could never reproduce.
      if (row.explain) {
        expect(row.explain.recommendedQty).toBe(row.recommendedQty);
        // The identity every rule satisfies: ordering the quantity brings the
        // shelf up to the level the rule targets.
        const { targetUnits, currentStock, onOrder } = row.explain;
        expect(Math.max(0, Math.ceil(targetUnits - currentStock - onOrder))).toBe(
          row.recommendedQty
        );
        // The mean-cover arithmetic holds only where mean cover set the target.
        if (row.explain.method === "mean_cover") {
          const { dailyForecast, coverDays, safetyStock } = row.explain;
          expect(Math.ceil(dailyForecast * coverDays + safetyStock)).toBe(Math.ceil(targetUnits));
        }
      }
    }
  });

  it("re-sizes the list to a cover horizon through the same engine, floored at lead", async () => {
    const base = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(base).not.toBeNull();

    const predictions = await prismaService.prediction.findMany({
      where: { tenantId: seeded.tenantId },
      include: { product: { include: { supplier: true } } },
    });
    const bySku = new Map(predictions.map((p) => [p.product.sku, p]));

    // The one engine at a lead-floored cover — the exact call the data layer
    // makes. Recomputed independently here, so a hand-rolled ceil (a second
    // formula) or a dropped input shows up as a mismatch.
    const engineQtyAt = (sku: string, requestedCover: number) => {
      const p = bySku.get(sku)!;
      const leadDays = leadDaysFor(p.product, p.product.supplier) ?? 0;
      return recommendedQty({
        finalForecast30d: p.finalForecast30d,
        safetyStock: p.safetyStock,
        currentStock: p.product.currentStock,
        onOrder: p.product.onOrder,
        coverDays: Math.max(requestedCover, leadDays),
      });
    };

    // No overrides set at this point, so every row is re-sized: its qty is the
    // engine's number at the lead-floored cover, and every qty-derived field
    // follows it. Rows that fall to 0 at this cover are dropped.
    const requested = 45;
    const sized = await getBuyList(seeded.tenantId, { canViewCosts: true, coverDays: requested });
    expect(sized).not.toBeNull();
    expect(sized!.rows.length).toBeGreaterThan(0);
    for (const row of sized!.rows) {
      const expected = engineQtyAt(row.sku, requested);
      expect(row.recommendedQty, row.sku).toBe(expected);
      expect(expected, row.sku).toBeGreaterThan(0);
      // The engine's number is what we need; the supplier's floor is what we
      // must buy. The line is priced on the second — these assertions used to
      // hold the first, which is the understatement #18 is about. The seeded
      // suppliers carry MOQs of 12, 24 and 48, so this is not hypothetical.
      expect(row.orderQty, row.sku).toBe(applyMoq(expected, row.moq));
      expect(row.lineTotalKes).toBeCloseTo(row.orderQty * row.unitCostKes!, 5);
      expect(row.qtySummary).toContain(`+ ${expected} ordered`);
    }
    expect(sized!.totalCostKes).toBeCloseTo(
      sized!.rows.reduce((s, r) => s + r.lineTotalKes!, 0),
      5
    );

    // For a mean-cover-regime row — its persisted qty IS the mean-cover number
    // at its own lead+review cover — the slider at coverDaysFor reproduces the
    // persisted qty exactly (proving it reuses the same engine), and a longer
    // cover raises it. Guarded: under the default tenant config classes resolve
    // to calibrated/min-max policies, so such a row is present only when the
    // seed leaves one on the mean-cover branch.
    const meanCover = base!.rows.find((r) => {
      const p = bySku.get(r.sku)!;
      const cover = coverDaysFor(p.product, p.product.supplier);
      return p.finalForecast30d > 0 && engineQtyAt(r.sku, cover) === Math.round(p.recommendedQty);
    });
    if (meanCover) {
      const p = bySku.get(meanCover.sku)!;
      const cover = coverDaysFor(p.product, p.product.supplier);
      const atCover = await getBuyList(seeded.tenantId, { canViewCosts: true, coverDays: cover });
      expect(atCover!.rows.find((r) => r.sku === meanCover.sku)!.recommendedQty).toBe(
        Math.round(p.recommendedQty)
      );
      const longer = await getBuyList(seeded.tenantId, { canViewCosts: true, coverDays: cover + 90 });
      expect(longer!.rows.find((r) => r.sku === meanCover.sku)!.recommendedQty).toBeGreaterThan(
        Math.round(p.recommendedQty)
      );
    }
  });

  it("re-size respects the owner override and keeps costs money-blind", async () => {
    const base = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = base!.rows[0]!;
    const pinned = target.recommendedQty + 13;
    try {
      await upsertPlanOverride(seeded.tenantId, { productId: target.productId, qty: pinned });

      // A cover horizon that would re-size the row must not move an overridden
      // one — the owner's number wins over the what-if.
      const sized = await getBuyList(seeded.tenantId, { canViewCosts: true, coverDays: 90 });
      const row = sized!.rows.find((r) => r.productId === target.productId)!;
      expect(row.overriddenQty).toBe(pinned);
      expect(row.recommendedQty).toBe(pinned);
      expect(row.lineTotalKes).toBeCloseTo(pinned * row.unitCostKes!, 5);

      // A money-blind member gets the re-sized list with costs redacted.
      const member = await getBuyList(seeded.tenantId, { canViewCosts: false, coverDays: 90 });
      const blind = member!.rows.find((r) => r.productId === target.productId)!;
      expect(blind.recommendedQty).toBe(pinned);
      expect(blind.lineTotalKes).toBeNull();
      expect(blind.unitCostKes).toBeNull();
      expect(blind.atRiskKes).toBeNull();
      expect(member!.totalCostKes).toBeNull();
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
    }
  });

  it("re-sizes the list for a sales push through the same engine, lifting demand", async () => {
    const base = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(base).not.toBeNull();

    const predictions = await prismaService.prediction.findMany({
      where: { tenantId: seeded.tenantId },
      include: { product: { include: { supplier: true } } },
    });
    const bySku = new Map(predictions.map((p) => [p.product.sku, p]));

    // The one engine over the item's own lead+review cover with demand lifted —
    // the exact call the data layer makes for the uplift path. Recomputed here,
    // so a second formula or a dropped input shows up as a mismatch. No policy is
    // passed, so it stays mean-cover, whatever the persisted regime was.
    const engineUpliftAt = (sku: string, multiplier: number) => {
      const p = bySku.get(sku)!;
      return recommendedQty({
        finalForecast30d: p.finalForecast30d * multiplier,
        safetyStock: p.safetyStock,
        currentStock: p.product.currentStock,
        onOrder: p.product.onOrder,
        coverDays: coverDaysFor(p.product, p.product.supplier),
      });
    };

    // A no-op uplift (1x) is the persisted plan, byte-for-byte: same rows, same
    // order, same quantities and line totals as the default fetch. This is the
    // one-engine contract — a 0% push must not perturb anything.
    const noop = await getBuyList(seeded.tenantId, { canViewCosts: true, demandUplift: 1 });
    expect(noop!.rows.map((r) => r.predictionId)).toEqual(base!.rows.map((r) => r.predictionId));
    for (const row of noop!.rows) {
      const b = base!.rows.find((r) => r.predictionId === row.predictionId)!;
      expect(row.recommendedQty, row.sku).toBe(b.recommendedQty);
      expect(row.lineTotalKes).toBeCloseTo(b.lineTotalKes!, 5);
    }

    // A +100% push doubles expected demand: no override is set, so every emitted
    // row is the engine's number at the lifted demand, and every qty-derived
    // field follows it. Rows that still fall to 0 are dropped.
    const lifted = await getBuyList(seeded.tenantId, { canViewCosts: true, demandUplift: 2 });
    expect(lifted).not.toBeNull();
    expect(lifted!.rows.length).toBeGreaterThan(0);
    for (const row of lifted!.rows) {
      const expected = engineUpliftAt(row.sku, 2);
      expect(row.recommendedQty, row.sku).toBe(expected);
      expect(expected, row.sku).toBeGreaterThan(0);
      // The engine's number is what we need; the supplier's floor is what we
      // must buy. The line is priced on the second — these assertions used to
      // hold the first, which is the understatement #18 is about. The seeded
      // suppliers carry MOQs of 12, 24 and 48, so this is not hypothetical.
      expect(row.orderQty, row.sku).toBe(applyMoq(expected, row.moq));
      expect(row.lineTotalKes).toBeCloseTo(row.orderQty * row.unitCostKes!, 5);
      expect(row.qtySummary).toContain(`+ ${expected} ordered`);
    }
    expect(lifted!.totalCostKes).toBeCloseTo(
      lifted!.rows.reduce((s, r) => s + r.lineTotalKes!, 0),
      5
    );

    // For a mean-cover-regime row — its persisted qty IS the mean-cover number at
    // its own cover — lifting demand raises the order strictly above the plan,
    // proving the uplift feeds the same sizing engine. Guarded: under the default
    // tenant config classes resolve to calibrated/min-max, so such a row is
    // present only when the seed leaves one on the mean-cover branch.
    const meanCover = base!.rows.find((r) => {
      const p = bySku.get(r.sku)!;
      return p.finalForecast30d > 0 && engineUpliftAt(r.sku, 1) === Math.round(p.recommendedQty);
    });
    if (meanCover) {
      const p = bySku.get(meanCover.sku)!;
      const liftedRow = lifted!.rows.find((r) => r.sku === meanCover.sku)!;
      expect(liftedRow.recommendedQty).toBe(engineUpliftAt(meanCover.sku, 2));
      expect(liftedRow.recommendedQty).toBeGreaterThan(Math.round(p.recommendedQty));
    }
  });

  it("a sales-push re-size respects the owner override and keeps costs money-blind", async () => {
    const base = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = base!.rows[0]!;
    const pinned = target.recommendedQty + 13;
    try {
      await upsertPlanOverride(seeded.tenantId, { productId: target.productId, qty: pinned });

      // A sales push that would re-size the row must not move an overridden one —
      // the owner's number wins over the what-if.
      const lifted = await getBuyList(seeded.tenantId, { canViewCosts: true, demandUplift: 2 });
      const row = lifted!.rows.find((r) => r.productId === target.productId)!;
      expect(row.overriddenQty).toBe(pinned);
      expect(row.recommendedQty).toBe(pinned);
      expect(row.lineTotalKes).toBeCloseTo(pinned * row.unitCostKes!, 5);

      // A money-blind member gets the lifted list with costs redacted.
      const member = await getBuyList(seeded.tenantId, { canViewCosts: false, demandUplift: 2 });
      const blind = member!.rows.find((r) => r.productId === target.productId)!;
      expect(blind.recommendedQty).toBe(pinned);
      expect(blind.lineTotalKes).toBeNull();
      expect(blind.unitCostKes).toBeNull();
      expect(blind.atRiskKes).toBeNull();
      expect(member!.totalCostKes).toBeNull();
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
    }
  });

  it("splits the list against a budget: sums reconcile, and the cap holds", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const rows = buyList!.rows;

    // Everything seeded has sane unit economics, so nothing lands in checkCost.
    const full = splitByBudget(rows, buyList!.totalCostKes!);
    expect(full.checkCost).toHaveLength(0);
    expect(full.deferred).toHaveLength(0);
    expect(full.funded).toHaveLength(rows.length);
    expect(full.fundedCostKes).toBeCloseTo(buyList!.totalCostKes!, 5);
    expect(full.leftoverKes).toBeCloseTo(0, 5);

    const half = splitByBudget(rows, buyList!.totalCostKes! / 2);
    expect(half.funded.length + half.deferred.length).toBe(rows.length);
    expect(half.fundedCostKes! + half.deferredCostKes!).toBeCloseTo(buyList!.totalCostKes!, 5);
    expect(half.fundedCostKes).toBeCloseTo(
      half.funded.reduce((sum, r) => sum + r.lineTotalKes!, 0),
      5
    );
    expect(half.deferredAtRiskKes).toBeCloseTo(
      half.deferred.reduce((sum, r) => sum + r.atRiskKes!, 0),
      5
    );
    // No overlap between the splits.
    const fundedIds = new Set(half.funded.map((r) => r.predictionId));
    for (const row of half.deferred) expect(fundedIds.has(row.predictionId)).toBe(false);
    // The cap holds: a budget the plan can exceed is not a budget.
    expect(half.fundedCostKes!).toBeLessThanOrEqual(buyList!.totalCostKes! / 2);
    expect(half.overBudgetKes).toBe(0);

    // Zero budget funds nothing, and says how much of what it dropped was
    // must-restock — the cost of the cap, stated rather than absorbed.
    const zero = splitByBudget(rows, 0);
    const criticals = rows.filter((r) => r.urgency === "critical");
    expect(zero.funded).toHaveLength(0);
    expect(zero.overBudgetKes).toBe(0);
    expect(zero.deferredCriticalCount).toBe(criticals.length);
    expect(zero.deferredCriticalKes).toBeCloseTo(
      criticals.reduce((sum, r) => sum + r.lineTotalKes!, 0),
      5
    );

    // Opting out restores the older behaviour: criticals funded whatever the
    // cap, the overrun reported instead of hidden.
    const overflow = splitByBudget(rows, 0, { strict: false });
    expect(new Set(overflow.funded.map((r) => r.predictionId))).toEqual(
      new Set(criticals.map((r) => r.predictionId))
    );
    expect(overflow.deferredCriticalCount).toBe(0);
    expect(overflow.overBudgetKes).toBeCloseTo(
      criticals.reduce((sum, r) => sum + r.lineTotalKes!, 0),
      5
    );
  });

  it("orders the quantity the owner set, not the one the engine suggested", async () => {
    // The override was display-only: the buy list showed the owner's number while
    // the order — and the purchase order built from it — carried the engine's, so
    // a supplier was sent a quantity nobody chose. Asserted against the engine's
    // own figure so it cannot pass by coincidence.
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = buyList!.rows[0]!;
    const owner = Math.round(target.recommendedQty) + 17;

    await upsertPlanOverride(seeded.tenantId, {
      productId: target.productId,
      qty: owner,
      createdByUserId: null,
      createdByName: null,
    });
    try {
      await createOrdersForPredictions(seeded.tenantId, [target.predictionId]);
      const order = await prismaService.order.findFirst({
        where: { tenantId: seeded.tenantId, predictionId: target.predictionId, status: "pending" },
        select: { orderedQty: true },
      });
      expect(order?.orderedQty, "the order carried the engine's quantity").toBe(owner);
    } finally {
      await prismaService.order.deleteMany({
        where: { tenantId: seeded.tenantId, predictionId: target.predictionId },
      });
      await removePlanOverride(seeded.tenantId, target.productId);
    }
  });

  it("creates pending Orders for ticked predictions and updates on re-add", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: true });
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
      expect(await getBuyList(probe.id, { canViewCosts: true })).toBeNull();

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

  it("an owner override replaces the engine qty and recomputes the line total", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const other = before!.rows.find((r) => r.productId !== target.productId)!;
    const newQty = target.recommendedQty + 7;
    try {
      await upsertPlanOverride(seeded.tenantId, { productId: target.productId, qty: newQty });
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      const overridden = after!.rows.find((r) => r.productId === target.productId)!;
      expect(overridden.overriddenQty).toBe(newQty);
      expect(overridden.recommendedQty).toBe(newQty);
      expect(overridden.lineTotalKes).toBeCloseTo(newQty * overridden.unitCostKes!, 5);
      // The qty breakdown follows the override, not the engine's original number.
      expect(overridden.qtySummary).toContain(`+ ${newQty} ordered`);

      // One-engine default: every other product is untouched by the override.
      const untouched = after!.rows.find((r) => r.productId === other.productId)!;
      expect(untouched.overriddenQty).toBeNull();
      expect(untouched.recommendedQty).toBe(other.recommendedQty);
      expect(untouched.lineTotalKes).toBeCloseTo(other.lineTotalKes!, 5);
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
    }
  });

  it("clearing the override reverts the row to the engine quantity", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const engineQty = target.recommendedQty;

    await upsertPlanOverride(seeded.tenantId, { productId: target.productId, qty: engineQty + 3 });
    await removePlanOverride(seeded.tenantId, target.productId);

    const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const row = after!.rows.find((r) => r.productId === target.productId)!;
    expect(row.overriddenQty).toBeNull();
    expect(row.recommendedQty).toBe(engineQty);
  });

  it("an override survives a re-plan that wipes and recreates every prediction", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = before!.rows[0]!;
    const predBefore = target.predictionId;
    const newQty = target.recommendedQty + 11;
    try {
      await upsertPlanOverride(seeded.tenantId, { productId: target.productId, qty: newQty });
      // The nightly pipeline: prediction.deleteMany({}) then recreate — new ids.
      await runForecast(seeded.tenantId);
      const after = await getBuyList(seeded.tenantId, { canViewCosts: true });
      const row = after!.rows.find((r) => r.productId === target.productId)!;
      expect(row.predictionId).not.toBe(predBefore); // predictions really were rebuilt
      expect(row.overriddenQty).toBe(newQty); // productId-keyed override still applies
      expect(row.recommendedQty).toBe(newQty);
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
    }
  }, 60_000);

  it("an overridden row keeps its line total hidden from a money-blind member", async () => {
    const owner = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const target = owner!.rows[0]!;
    const newQty = target.recommendedQty + 5;
    try {
      await upsertPlanOverride(seeded.tenantId, { productId: target.productId, qty: newQty });
      const member = await getBuyList(seeded.tenantId, { canViewCosts: false });
      const row = member!.rows.find((r) => r.productId === target.productId)!;
      // The quantity itself is operational — a member still sees it.
      expect(row.overriddenQty).toBe(newQty);
      expect(row.recommendedQty).toBe(newQty);
      // The money the override implies stays redacted.
      expect(row.lineTotalKes).toBeNull();
      expect(row.unitCostKes).toBeNull();
      expect(row.atRiskKes).toBeNull();
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
    }
  });

  it("overrides are tenant-scoped: a foreign tenant reads none", async () => {
    const target = (await getBuyList(seeded.tenantId, { canViewCosts: true }))!.rows[0]!;
    const probe = await prismaService.tenant.create({
      data: { name: "Override Probe", slug: "override-probe" },
    });
    try {
      await upsertPlanOverride(seeded.tenantId, { productId: target.productId, qty: 99 });

      // The probe's scope sees no overrides — not even asking for the exact id.
      const foreign = await prismaForTenant(probe.id).productPlanOverride.findMany({
        where: { productId: target.productId },
      });
      expect(foreign).toEqual([]);

      // A write under the probe's scope naming the victim's product is refused
      // outright. RLS could never have caught this one — on a create there is no
      // row for it to filter, and ProductPlanOverride carries no foreign key on
      // productId — so the writer resolves the product on the tenant client
      // first. Aiming only at the READ above let the WRITE through.
      await expect(
        upsertPlanOverride(probe.id, { productId: target.productId, qty: 1 })
      ).rejects.toThrow();
      const victim = await prismaForTenant(seeded.tenantId).productPlanOverride.findMany({
        where: { productId: target.productId },
      });
      expect(victim).toHaveLength(1);
      expect(victim[0]!.qty).toBe(99);
      expect(victim[0]!.tenantId).toBe(seeded.tenantId);
    } finally {
      await removePlanOverride(seeded.tenantId, target.productId);
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
      leadDays: 5,
      orderByDate: new Date(),
      urgency: "medium",
      tier: "this_week",
      recommendedQty: 10,
      orderQty: 10,
      overriddenQty: null,
      runRatePerDay: 1,
      moq: 1,
      leadFloored: false,
      abc: null,
      category: null,
      unitCostKes: 100,
      lineTotalKes: 1000,
      priceKes: 200,
      reasoning: "test row",
      explain: null,
      qtySummary: "test summary",
      plannable: "ok",
      atRiskKes: 0,
      revenue30dKes: 0,
      confidence: "sure",
      coldStart: null,
      borrowedFromTitle: null,
      ...partial,
    };
  }

  /** A BuyList wrapper for the ordering tests — only `rows` matters to them. */
  function mkBuyList(rows: BuyListRow[]): BuyList {
    return {
      forecastRunId: "run-1",
      runDate: new Date(),
      rows,
      excluded: [],
      totalPredicted: rows.length,
      totalCostKes: 0,
    };
  }

  it("leads the list with class A, even over something more urgent", () => {
    // The client's instruction: bestsellers first. The consequence is deliberate
    // and worth pinning down — a class-C item stocking out tomorrow sits below
    // class-A items that still have weeks of cover, because a stockout on a
    // bestseller is the one that costs real money.
    const criticalC = mkRow({ abc: "C", urgency: "critical", daysUntilStockout: 1, sku: "C-CRIT" });
    const lowA = mkRow({ abc: "A", urgency: "low", daysUntilStockout: 30, sku: "A-LOW" });
    const criticalA = mkRow({ abc: "A", urgency: "critical", daysUntilStockout: 2, sku: "A-CRIT" });
    const mediumB = mkRow({ abc: "B", urgency: "medium", daysUntilStockout: 9, sku: "B-MED" });
    const unclassified = mkRow({ abc: null, urgency: "critical", daysUntilStockout: 1, sku: "N-CRIT" });

    const sorted = redactBuyList(
      mkBuyList([mediumB, unclassified, lowA, criticalC, criticalA]),
      false,
    ).rows;

    expect(sorted.map((r) => r.sku)).toEqual([
      "A-CRIT", // class first, then urgency inside the class
      "A-LOW",
      "B-MED",
      "C-CRIT",
      "N-CRIT", // no class at all sorts last — too little history to rank it
    ]);
  });

  it("orders a money-blind list exactly as an owner's", () => {
    // Both sorts share the same head, so a member and an owner read the same
    // list in the same order — only the money is missing.
    const rows = [
      mkRow({ abc: "C", urgency: "critical", sku: "C-1", lineTotalKes: 9000 }),
      mkRow({ abc: "A", urgency: "low", sku: "A-1", lineTotalKes: 10 }),
      mkRow({ abc: "B", urgency: "high", sku: "B-1", lineTotalKes: 5000 }),
    ];
    const blind = redactBuyList(mkBuyList(rows), false);
    expect(blind.rows.map((r) => r.sku)).toEqual(["A-1", "B-1", "C-1"]);
    expect(blind.rows.every((r) => r.lineTotalKes === null)).toBe(true);
  });

  it("funds the budget by urgency, not by class", () => {
    // The list leads with bestsellers; the money must not. A budget that bought
    // class A while a critical item went unfunded is a stockout the shop paid for.
    const criticalC = mkRow({ abc: "C", urgency: "critical", sku: "C-CRIT", lineTotalKes: 600 });
    const lowA = mkRow({ abc: "A", urgency: "low", sku: "A-LOW", lineTotalKes: 600 });

    const split = splitByBudget([lowA, criticalC], 600);
    expect(split.funded.map((r) => r.sku)).toEqual(["C-CRIT"]);
    expect(split.deferred.map((r) => r.sku)).toEqual(["A-LOW"]);
  });

  it("routes broken-cost rows to checkCost, never into the split", () => {
    const good = mkRow({});
    const broken = mkRow({ plannable: "missing-cost", lineTotalKes: 0 });
    const split = splitByBudget([good, broken], 10_000);
    expect(split.checkCost.map((r) => r.predictionId)).toEqual([broken.predictionId]);
    expect(split.funded.map((r) => r.predictionId)).toEqual([good.predictionId]);
    expect(split.deferred).toHaveLength(0);
  });

  it("defers a critical that does not fit, and says what including it would cost", () => {
    const critical = mkRow({ urgency: "critical", lineTotalKes: 5000 });
    const medium = mkRow({ lineTotalKes: 1000 });
    // Criticals sort first, so this one is offered the budget before the medium
    // row — it simply does not fit, and the cap is not negotiable by default.
    const split = splitByBudget([medium, critical], 1000);
    expect(split.funded.map((r) => r.predictionId)).toEqual([medium.predictionId]);
    expect(split.fundedCostKes).toBe(1000);
    expect(split.overBudgetKes).toBe(0);
    expect(split.deferredCriticalCount).toBe(1);
    expect(split.deferredCriticalKes).toBe(5000);
  });

  it("funds criticals past the cap and reports the overflow when told to", () => {
    const critical = mkRow({ urgency: "critical", lineTotalKes: 5000 });
    const medium = mkRow({ lineTotalKes: 1000 });
    const split = splitByBudget([medium, critical], 1000, { strict: false });
    expect(split.funded.map((r) => r.predictionId)).toContain(critical.predictionId);
    expect(split.fundedCostKes).toBe(5000);
    expect(split.overBudgetKes).toBe(4000);
    expect(split.deferred.map((r) => r.predictionId)).toEqual([medium.predictionId]);
    expect(split.deferredCostKes).toBe(1000);
    // Nothing must-restock was held back, so nothing to warn about.
    expect(split.deferredCriticalCount).toBe(0);
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

/** Pure scope-bar filter — no database, no React. AND across the four
 *  dimensions, OR within each; lead band bucketed off resolved lead days. */
describe("filterBuyListRows (pure)", () => {
  let seq = 0;
  function mkRow(partial: Partial<BuyListRow>): BuyListRow {
    seq += 1;
    return {
      predictionId: `f-${seq}`,
      productId: `fp-${seq}`,
      sku: `FSKU-${seq}`,
      title: `Filter row ${seq}`,
      vendor: null,
      supplierName: null,
      onHandUnits: 10,
      onOrderUnits: 0,
      daysUntilStockout: 10,
      daysLeftToOrder: 5,
      leadDays: 5,
      orderByDate: new Date(),
      urgency: "medium",
      tier: "this_week",
      recommendedQty: 10,
      orderQty: 10,
      overriddenQty: null,
      runRatePerDay: 1,
      moq: 1,
      leadFloored: false,
      abc: null,
      category: null,
      unitCostKes: 100,
      lineTotalKes: 1000,
      priceKes: 200,
      reasoning: "test row",
      explain: null,
      qtySummary: "test summary",
      plannable: "ok",
      atRiskKes: 0,
      revenue30dKes: 0,
      confidence: "sure",
      coldStart: null,
      borrowedFromTitle: null,
      ...partial,
    };
  }

  const scope = (partial: Partial<ScopeSelection>): ScopeSelection => ({ ...EMPTY_SCOPE, ...partial });

  const fastA = mkRow({ abc: "A", category: "Drinks", supplierName: "Acme", leadDays: 3 });
  const medB = mkRow({ abc: "B", category: "Drinks", supplierName: "Beta", leadDays: 14 });
  const slowA = mkRow({ abc: "A", category: "Snacks", supplierName: "Acme", leadDays: 40 });
  const gap = mkRow({ abc: null, category: null, supplierName: null, leadDays: 7 });
  const rows = [fastA, medB, slowA, gap];
  const ids = (rs: BuyListRow[]) => rs.map((r) => r.predictionId);

  it("buckets lead days: fast ≤7, medium 8–28, slow >28", () => {
    expect(leadBandFor(0)).toBe("fast");
    expect(leadBandFor(7)).toBe("fast");
    expect(leadBandFor(8)).toBe("medium");
    expect(leadBandFor(28)).toBe("medium");
    expect(leadBandFor(29)).toBe("slow");
    expect(leadBandFor(40)).toBe("slow");
  });

  it("no selection returns the input list untouched (same reference)", () => {
    expect(filterBuyListRows(rows, EMPTY_SCOPE)).toBe(rows);
  });

  it("filters within a dimension as OR", () => {
    expect(ids(filterBuyListRows(rows, scope({ abc: ["A"] })))).toEqual(ids([fastA, slowA]));
    expect(ids(filterBuyListRows(rows, scope({ supplier: ["Acme", "Beta"] })))).toEqual(
      ids([fastA, medB, slowA])
    );
    expect(ids(filterBuyListRows(rows, scope({ category: ["Drinks"] })))).toEqual(ids([fastA, medB]));
  });

  it("buckets and filters by lead band", () => {
    expect(ids(filterBuyListRows(rows, scope({ leadBand: ["fast"] })))).toEqual(ids([fastA, gap]));
    expect(ids(filterBuyListRows(rows, scope({ leadBand: ["medium"] })))).toEqual(ids([medB]));
    expect(ids(filterBuyListRows(rows, scope({ leadBand: ["slow"] })))).toEqual(ids([slowA]));
  });

  it("combines dimensions as AND", () => {
    // A-class AND Drinks: slowA is A but Snacks, so only fastA survives.
    expect(ids(filterBuyListRows(rows, scope({ abc: ["A"], category: ["Drinks"] })))).toEqual(
      ids([fastA])
    );
    // Acme AND fast: slowA is Acme but slow, so only fastA survives.
    expect(ids(filterBuyListRows(rows, scope({ supplier: ["Acme"], leadBand: ["fast"] })))).toEqual(
      ids([fastA])
    );
  });

  it("scopes to the gaps via the none sentinel", () => {
    expect(ids(filterBuyListRows(rows, scope({ abc: [NONE_VALUE] })))).toEqual(ids([gap]));
    expect(ids(filterBuyListRows(rows, scope({ category: [NONE_VALUE] })))).toEqual(ids([gap]));
    expect(ids(filterBuyListRows(rows, scope({ supplier: [NONE_VALUE] })))).toEqual(ids([gap]));
  });

  it("returns nothing when no row matches the selection", () => {
    expect(filterBuyListRows(rows, scope({ category: ["Nonexistent"] }))).toEqual([]);
  });
});
