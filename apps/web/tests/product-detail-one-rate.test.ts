import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { layeredForecast } from "@wezesha/forecast";
import { getProductDetail } from "../lib/data/product-detail";
import { getCatalogueMetrics } from "../lib/metrics/catalogue";
import { ProductDetailView } from "../app/(shell)/stock/[productId]/product-detail-view";

/**
 * One question, one number. The product page puts a LIVE "Sells/day" and "Days
 * cover" tile above the last run's reasoning, and the reasoning used to quote a
 * rate and a cover of its own — frozen at the run, worded as though current. On
 * a product with recorded stockouts and a run a few days old the two disagree by
 * construction, and nothing on the screen said which one to believe.
 *
 * The product here is deliberately the hard case: fourteen days of proven empty
 * shelf inside the history, and a run dated ten days back.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const DAY_MS = 86_400_000;
const midnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const TODAY = midnight(new Date());
const RUN_DATE = new Date(+TODAY - 10 * DAY_MS);
/** The empty-shelf stretch: days 40-26 back, well inside the rate windows. */
const STOCKOUT_FROM = 40;
const STOCKOUT_TO = 26;

let tenantId: string;
let productId: string;

describe.skipIf(!runnable)("one rate on the product page (local db)", () => {
  beforeAll(async () => {
    const tenant = await prismaService.tenant.upsert({
      where: { slug: "product-detail-one-rate" },
      update: {},
      create: { name: "One Rate Detail", slug: "product-detail-one-rate", currency: "KES" },
      select: { id: true },
    });
    tenantId = tenant.id;
    await prismaService.product.deleteMany({ where: { tenantId } });

    const product = await prismaService.product.create({
      data: {
        tenantId,
        sku: "OR-STEADY-1",
        title: "Steady conditioner 500ml",
        priceKes: 1200,
        costKes: 500,
        currentStock: 60,
        leadTimeDays: 7,
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
      if (!empty) sales.push({ tenantId, productId, date, quantity: 4, revenueKes: 4800 });
      snapshots.push({ tenantId, productId, date, onHand: empty ? 0 : 60 });
    }
    await prismaService.salesHistory.createMany({ data: sales });
    await prismaService.inventorySnapshot.createMany({ data: snapshots });

    // The prediction the page renders is produced by the real engine, on the
    // same inputs the nightly run passes — a hand-written reasoning string would
    // prove nothing about what a run actually writes.
    const history = sales.map((s) => ({ date: s.date, quantity: s.quantity }));
    const stockoutDates = snapshots.filter((s) => s.onHand <= 0).map((s) => s.date);
    const result = layeredForecast({
      productId,
      productType: null,
      vendor: null,
      sku: "OR-STEADY-1",
      currentStock: 90, // the shelf as it stood at the run, since drifted to 60
      abcCategory: "B",
      history: history.filter((h) => h.date < RUN_DATE),
      leadTimeAvg: 7,
      leadTimeStd: 2,
      activePromos: [],
      runDateKey: RUN_DATE.toISOString().slice(0, 10),
      stockoutDates,
      snapshotsSince: new Date(+TODAY - 120 * DAY_MS),
    });
    await prismaService.prediction.create({
      data: {
        tenantId,
        productId,
        runDate: RUN_DATE,
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
  }, 120_000);

  afterAll(async () => {
    await prismaService.prediction.deleteMany({ where: { tenantId } });
    await prismaService.inventorySnapshot.deleteMany({ where: { tenantId } });
    await prismaService.salesHistory.deleteMany({ where: { tenantId } });
    await prismaService.product.deleteMany({ where: { tenantId } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  it("shows one sells-per-day figure, not the run's as well", async () => {
    const detail = await getProductDetail(tenantId, productId, { canViewCosts: true });
    const html = renderToStaticMarkup(
      createElement(ProductDetailView, { detail: detail!, canViewCosts: true })
    );

    // The live tile is the one answer to "how fast does this sell".
    expect(html).toContain("Sells/day");
    expect(html, "the run's own rate must not be quoted beside the live tile").not.toMatch(
      /\d[\d.]*\s*units\/day/
    );
    expect(html, "the run's own cover must not be written as though current").not.toMatch(
      /covers ~\d/
    );
  }, 120_000);

  it("stamps the run's block with the date it was computed", async () => {
    const detail = await getProductDetail(tenantId, productId, { canViewCosts: true });
    const html = renderToStaticMarkup(
      createElement(ProductDetailView, { detail: detail!, canViewCosts: true })
    );
    // The date has to sit with the block, not only in a footnote under it.
    const header = html.slice(0, html.indexOf(detail!.prediction!.reasoning));
    expect(header).toContain(detail!.prediction!.runLabel);
  }, 120_000);

  it("rates the product the same way the stock list does", async () => {
    // Same product, two screens: the catalogue drops proven empty-shelf days
    // from the denominator, so a page that forgets to pass them reads slower.
    const detail = await getProductDetail(tenantId, productId, { canViewCosts: true });
    const metrics = await getCatalogueMetrics(tenantId);
    const listed = metrics.get(productId)!;

    expect(detail!.runRatePerDay).toBe(Math.round(listed.runRate * 100) / 100);
    expect(detail!.daysCover).toBe(listed.coverDays);
  }, 120_000);
});
