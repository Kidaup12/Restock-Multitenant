import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { layeredForecast } from "@wezesha/forecast";
import { getBuyList } from "../lib/data/plan";
import { getCatalogueMetrics } from "../lib/metrics/catalogue";

/**
 * The plan's "Run/day" and the stock list's "Sells/day" are the same question in
 * two vocabularies, and the metric contract gives that question ONE answer: the
 * engine's recency-weighted, stockout-corrected rate.
 *
 * The plan used to print `finalForecast30d / 30` instead — the SIZED number,
 * after the promo lift and the runaway cap. That is what to order against, not
 * how fast the shop sells, so the two screens read 15-35% apart on the same
 * product.
 *
 * The product here is built so the two quantities cannot coincide: a fortnight
 * of proven empty shelf (so the rate is stockout-corrected and a naive
 * units/days would be wrong too) plus an active promo lifting the forecast well
 * above the run rate.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const DAY_MS = 86_400_000;
const midnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const TODAY = midnight(new Date());
/** The empty-shelf stretch: days 40-26 back, well inside the rate windows. */
const STOCKOUT_FROM = 40;
const STOCKOUT_TO = 26;
const SKU = "ONE-RATE-PLAN-1";
/** The straddler: run rate under a unit a day, sized demand over it. */
const SLOW_SKU = "ONE-RATE-PLAN-2";
/** Both predictions belong to ONE run — the plan only reads the latest run id,
 *  and Prediction defaults that column per row. */
const RUN_ID = "one-rate-plan-run";

let tenantId: string;
let productId: string;
let slowProductId: string;
let layer1Forecast30d: number;
let finalForecast30d: number;
let slowFields: { layer1Forecast30d: number; finalForecast30d: number; urgency: string; recommendedQty: number };

describe.skipIf(!runnable)("one rate across plan and stock (local db)", () => {
  beforeAll(async () => {
    const tenant = await prismaService.tenant.upsert({
      where: { slug: "plan-one-rate" },
      update: {},
      create: { name: "One Rate Plan", slug: "plan-one-rate", currency: "KES" },
      select: { id: true },
    });
    tenantId = tenant.id;
    await prismaService.product.deleteMany({ where: { tenantId } });

    const product = await prismaService.product.create({
      data: {
        tenantId,
        sku: SKU,
        title: "Curling cream 355ml",
        priceKes: 1500,
        costKes: 600,
        currentStock: 12,
        leadTimeDays: 7,
        abcCategory: "B",
      },
      select: { id: true },
    });
    productId = product.id;

    // 120 days of steady demand with a fortnight of empty shelf in the middle.
    const sales: { tenantId: string; productId: string; date: Date; quantity: number; revenueKes: number }[] = [];
    const snapshots: { tenantId: string; productId: string; date: Date; onHand: number }[] = [];
    for (let back = 120; back >= 1; back--) {
      const date = new Date(+TODAY - back * DAY_MS);
      const empty = back <= STOCKOUT_FROM && back >= STOCKOUT_TO;
      if (!empty) sales.push({ tenantId, productId, date, quantity: 3, revenueKes: 4500 });
      snapshots.push({ tenantId, productId, date, onHand: empty ? 0 : 40 });
    }
    await prismaService.salesHistory.createMany({ data: sales });
    await prismaService.inventorySnapshot.createMany({ data: snapshots });

    // The prediction comes from the real engine on the inputs the nightly run
    // passes — a hand-written pair of numbers would prove nothing about what a
    // run actually writes. The promo is what drives final above layer 1.
    const result = layeredForecast({
      productId,
      productType: null,
      vendor: null,
      sku: SKU,
      currentStock: 12,
      abcCategory: "B",
      history: sales.map((s) => ({ date: s.date, quantity: s.quantity })),
      leadTimeAvg: 7,
      leadTimeStd: 2,
      activePromos: [
        { discountPct: 20, promoType: "percentage", channel: "shopify", scope: "sku", scopeValue: SKU },
      ],
      runDateKey: TODAY.toISOString().slice(0, 10),
      stockoutDates: snapshots.filter((s) => s.onHand <= 0).map((s) => s.date),
      snapshotsSince: new Date(+TODAY - 120 * DAY_MS),
    });
    layer1Forecast30d = result.layer1Forecast30d;
    finalForecast30d = result.finalForecast30d;

    await prismaService.prediction.create({
      data: {
        tenantId,
        productId,
        runDate: TODAY,
        forecastRunId: RUN_ID,
        layer1Forecast30d: result.layer1Forecast30d,
        layer1Confidence: result.layer1Confidence,
        layer2Adjustment: result.layer2Adjustment,
        finalForecast30d: result.finalForecast30d,
        daysUntilStockout: result.daysUntilStockout,
        recommendedQty: result.recommendedQty,
        safetyStock: result.safetyStock,
        reorderPoint: result.reorderPoint,
        confidence: result.confidence,
        reasoning: result.reasoning,
        urgency: result.urgency,
        signals: JSON.stringify(result.signals),
        confidenceWord: result.confidenceWord,
      },
    });

    // Second product, built to straddle the slow-mover line: it sells a little
    // under a unit a day, and the same promo lifts the SIZED demand just over
    // it. The two candidate gates disagree about this row, which is the only way
    // to prove which one the plan uses.
    const slow = await prismaService.product.create({
      data: {
        tenantId,
        sku: SLOW_SKU,
        title: "Roll-on 50ml",
        priceKes: 400,
        costKes: 150,
        currentStock: 0, // set below, once the rate is known
        leadTimeDays: 7,
        abcCategory: "C",
      },
      select: { id: true },
    });
    slowProductId = slow.id;

    // ~0.9/day: one unit on nine days in ten, over the same 120 days. Spread
    // thin rather than lumped, so no gap is long enough to read as a stockout.
    const slowSales = [];
    for (let back = 120; back >= 1; back--) {
      if (back % 10 === 0) continue;
      slowSales.push({
        tenantId,
        productId: slowProductId,
        date: new Date(+TODAY - back * DAY_MS),
        quantity: 1,
        revenueKes: 400,
      });
    }
    await prismaService.salesHistory.createMany({ data: slowSales });

    const slowInput = {
      productId: slowProductId,
      productType: null,
      vendor: null,
      sku: SLOW_SKU,
      abcCategory: "C" as const,
      history: slowSales.map((s) => ({ date: s.date, quantity: s.quantity })),
      leadTimeAvg: 7,
      leadTimeStd: 2,
      activePromos: [
        // A big discount, so the lift clears the line by a margin no rounding
        // or spike-damping can close.
        { discountPct: 50, promoType: "percentage", channel: "shopify", scope: "sku", scopeValue: SLOW_SKU },
      ],
      runDateKey: TODAY.toISOString().slice(0, 10),
    };
    // Stock it to just over a month of cover, so urgency lands on "low" and the
    // run still sizes something — both halves the slow-mover gate needs. The
    // rate decides the level, so the seed adapts instead of hardcoding it.
    const probe = layeredForecast({ ...slowInput, currentStock: 0 });
    const slowStock = Math.round(31 * (probe.layer1Forecast30d / 30));
    const slowResult = layeredForecast({ ...slowInput, currentStock: slowStock });
    slowFields = {
      layer1Forecast30d: slowResult.layer1Forecast30d,
      finalForecast30d: slowResult.finalForecast30d,
      urgency: slowResult.urgency,
      recommendedQty: slowResult.recommendedQty,
    };
    await prismaService.product.update({
      where: { id: slowProductId },
      data: { currentStock: slowStock },
    });
    await prismaService.prediction.create({
      data: {
        tenantId,
        productId: slowProductId,
        runDate: TODAY,
        forecastRunId: RUN_ID,
        layer1Forecast30d: slowResult.layer1Forecast30d,
        layer1Confidence: slowResult.layer1Confidence,
        layer2Adjustment: slowResult.layer2Adjustment,
        finalForecast30d: slowResult.finalForecast30d,
        daysUntilStockout: slowResult.daysUntilStockout,
        recommendedQty: slowResult.recommendedQty,
        safetyStock: slowResult.safetyStock,
        reorderPoint: slowResult.reorderPoint,
        confidence: slowResult.confidence,
        reasoning: slowResult.reasoning,
        urgency: slowResult.urgency,
        signals: JSON.stringify(slowResult.signals),
        confidenceWord: slowResult.confidenceWord,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await prismaService.prediction.deleteMany({ where: { tenantId } });
    await prismaService.inventorySnapshot.deleteMany({ where: { tenantId } });
    await prismaService.salesHistory.deleteMany({ where: { tenantId } });
    await prismaService.product.deleteMany({ where: { tenantId } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  /** Negative control on the seed itself: with the promo lift folded in, the
   *  sized forecast and the run rate are far enough apart that a row reading
   *  either one is unambiguous. Without this a green result above could just be
   *  two identical numbers. */
  it("seeds a product whose sized forecast is not its run rate", () => {
    expect(finalForecast30d).toBeGreaterThan(layer1Forecast30d * 1.2);
  });

  it("rates the product the same way the stock list does", async () => {
    const buyList = await getBuyList(tenantId, { canViewCosts: true });
    const row =
      buyList!.rows.find((r) => r.productId === productId) ??
      buyList!.excluded.find((r) => r.productId === productId)!;
    // Anchored on the run's own day. Stock recomputes live and the plan reads a
    // stored run, so at different anchors the two drift by the clock — a
    // separate, honest gap. Holding the anchor still is what isolates the thing
    // under test: whether the two screens answer the same QUESTION.
    const listed = (await getCatalogueMetrics(tenantId, { asOf: TODAY })).get(productId)!;

    // The plan rounds to one decimal for the column; the comparison rounds the
    // stock figure the same way rather than loosening the assertion.
    expect(row.runRatePerDay).toBe(Math.round(listed.runRate * 10) / 10);
    // And it is not the sized forecast wearing a rate's label.
    expect(row.runRatePerDay).not.toBe(Math.round((finalForecast30d / 30) * 10) / 10);
  }, 120_000);

  /** The other half of the change: correcting the DISPLAYED rate must not move
   *  products on or off the buy list. The slow-mover gate reads the sized daily
   *  demand, as it always has — this row sells under a unit a day and is sized
   *  at over one, so a gate keyed on the new rate would hold it back and this
   *  test fails. */
  it("does not re-decide the slow-mover hold on the corrected rate", async () => {
    // The seed has to actually straddle the line, or the row proves nothing.
    expect(slowFields.urgency).toBe("low");
    expect(slowFields.recommendedQty).toBeGreaterThan(0);
    expect(slowFields.layer1Forecast30d / 30).toBeLessThan(1);
    expect(slowFields.finalForecast30d / 30).toBeGreaterThanOrEqual(1);

    const buyList = await getBuyList(tenantId, { canViewCosts: true });
    const held = buyList!.excluded.find((r) => r.productId === slowProductId);
    const active = buyList!.rows.find((r) => r.productId === slowProductId);

    expect(held?.reason).toBeUndefined();
    expect(active).toBeDefined();
    // ...while still SHOWING the rate it actually sells at.
    expect(active!.runRatePerDay).toBeLessThan(1);
  }, 120_000);
});
