import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { getProductDetail, type ProductDetail } from "../lib/data/product-detail";
import { ProductDetailView } from "../app/(shell)/products/[productId]/product-detail-view";

/**
 * Cold start is one fact with two screens. The plan chips a too-new or borrowed
 * product so the owner knows the number came from something other than this
 * product's own sales; the product page — the screen someone opens to decide
 * about that one product — never carried the fact at all. On the live tenant
 * that is 52 of 121 predictions.
 *
 * The DB half proves the getter reads the run's own columns; the render half
 * proves the page prints the plan's words, and prints nothing when there is no
 * cold start — a chip that is always there stops being a signal.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

let tenantId: string;
let productId: string;
let proxyId: string;

/** Enough of a run row to be the latest prediction for a product. */
const predictionData = (over: Record<string, unknown>) => ({
  tenantId,
  productId,
  runDate: new Date("2026-08-12T00:00:00Z"),
  layer1Forecast30d: 0,
  layer1Confidence: 0,
  layer2Adjustment: 0,
  finalForecast30d: 0,
  daysUntilStockout: 999,
  recommendedQty: 0,
  safetyStock: 0,
  reorderPoint: 0,
  confidence: 0.2,
  reasoning: "No sales history yet — too new to forecast.",
  urgency: "low",
  signals: "{}",
  confidenceWord: "guessing",
  ...over,
});

describe.skipIf(!runnable)("cold start on the product page (local db)", () => {
  beforeAll(async () => {
    const tenant = await prismaService.tenant.upsert({
      where: { slug: "product-detail-cold-start" },
      update: {},
      create: { name: "Cold Start Detail", slug: "product-detail-cold-start", currency: "KES" },
      select: { id: true },
    });
    tenantId = tenant.id;
    const product = await prismaService.product.create({
      data: {
        tenantId,
        sku: "CS-NEW-1",
        title: "Brand new shampoo 400ml",
        priceKes: 900,
        costKes: 400,
        currentStock: 6,
      },
      select: { id: true },
    });
    productId = product.id;
    const proxy = await prismaService.product.create({
      data: {
        tenantId,
        sku: "CS-PROXY-1",
        title: "Shea Butter 250ml",
        priceKes: 800,
        costKes: 350,
        currentStock: 40,
      },
      select: { id: true },
    });
    proxyId = proxy.id;
  }, 60_000);

  afterAll(async () => {
    await prismaService.prediction.deleteMany({ where: { tenantId } });
    await prismaService.product.deleteMany({ where: { tenantId } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  it("carries a too-new run's own cold-start state", async () => {
    await prismaService.prediction.deleteMany({ where: { tenantId } });
    await prismaService.prediction.create({ data: predictionData({ coldStart: "too_new" }) });

    const detail = await getProductDetail(tenantId, productId, { canViewCosts: true });
    expect(detail!.prediction!.coldStart).toBe("too_new");
    expect(detail!.prediction!.borrowedFromTitle).toBeNull();
  }, 60_000);

  it("names the product a borrowed run borrowed from", async () => {
    await prismaService.prediction.deleteMany({ where: { tenantId } });
    await prismaService.prediction.create({
      data: predictionData({ coldStart: "borrowed", borrowedFromProductId: proxyId }),
    });

    const detail = await getProductDetail(tenantId, productId, { canViewCosts: true });
    expect(detail!.prediction!.coldStart).toBe("borrowed");
    expect(detail!.prediction!.borrowedFromTitle).toBe("Shea Butter 250ml");
  }, 60_000);

  it("says nothing when the run had its own history to work from", async () => {
    await prismaService.prediction.deleteMany({ where: { tenantId } });
    await prismaService.prediction.create({
      data: predictionData({ coldStart: null, reasoning: "Steady seller." }),
    });

    const detail = await getProductDetail(tenantId, productId, { canViewCosts: true });
    expect(detail!.prediction!.coldStart).toBeNull();
    expect(detail!.prediction!.borrowedFromTitle).toBeNull();
  }, 60_000);
});

const detailFixture = (
  prediction: Partial<NonNullable<ProductDetail["prediction"]>> | null
): ProductDetail => ({
  productId: "prod-1",
  sku: "CS-NEW-1",
  title: "Brand new shampoo 400ml",
  variantTitle: null,
  vendor: null,
  productType: null,
  imageUrl: null,
  abc: "C",
  lifecycle: "active",
  lifecycleLabel: "Active",
  heldReason: null,
  shopifyStatus: "active",
  onHandUnits: 6,
  onOrderUnits: 0,
  expectedArrivalLabel: null,
  runRatePerDay: 0,
  daysCover: null,
  priceKes: 900,
  unitCostKes: 400,
  costSource: "typed",
  stockValueKes: 2400,
  supplierName: null,
  supplierLeadDays: null,
  supplierMoq: null,
  effectiveLeadDays: 14,
  months: [],
  revenue30dKes: 0,
  prediction: prediction && {
    recommendedQty: 0,
    urgency: "low",
    confidenceWord: "guessing",
    reasoning: "No sales history yet — too new to forecast.",
    daysUntilStockout: null,
    runLabel: "12 Aug 2026",
    coldStart: null,
    borrowedFromTitle: null,
    ...prediction,
  },
});

const render = (detail: ProductDetail) =>
  renderToStaticMarkup(createElement(ProductDetailView, { detail, canViewCosts: true }));

describe("the cold-start chip on the product page", () => {
  it("chips a too-new product in the plan's words", () => {
    expect(render(detailFixture({ coldStart: "too_new" }))).toContain("Too new");
  });

  it("names the borrowed-from product", () => {
    const html = render(
      detailFixture({ coldStart: "borrowed", borrowedFromTitle: "Shea Butter 250ml" })
    );
    expect(html).toContain("Selling like Shea Butter 250ml");
  });

  it("degrades to a similar product when the proxy has since gone", () => {
    const html = render(detailFixture({ coldStart: "borrowed", borrowedFromTitle: null }));
    expect(html).toContain("Selling like a similar product");
  });

  it("shows no chip at all when the run had history of its own", () => {
    const html = render(detailFixture({ coldStart: null }));
    expect(html).not.toContain("Too new");
    expect(html).not.toContain("Selling like");
  });
});
