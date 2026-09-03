import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductTabs } from "@/app/(shell)/today/product-tabs";
import type { CatalogueRow } from "@/lib/data/stock";
import type { DashboardTable } from "@/lib/data/today";

/**
 * What a dashboard row says beyond its name.
 *
 * The table listed a title, a SKU and four numbers. Every row in the Stockout
 * pile therefore looked identical in kind — nothing on the line distinguished
 * a shelf that is empty from one that empties on Friday, and the SKU code is
 * the one thing on the row a buyer does not know by heart.
 */

const row = (over: Partial<CatalogueRow> = {}): CatalogueRow =>
  ({
    productId: over.productId ?? "p1",
    sku: "NL-BJ-250",
    title: "Nice & Lovely Baby Jelly 250g",
    variantTitle: null,
    shopifyProductId: null,
    vendor: "Nice & Lovely",
    onHandUnits: 12,
    warehouseUnits: 0,
    daysCover: 20,
    urgency: "low",
    priceKes: 400,
    runRate: 0.6,
    revenue30dKes: 7200,
    costKes: 200,
    stockValueKes: 2400,
    moneyAtRestKes: 2400,
    abc: "A",
    customCategory: null,
    costSource: "manual",
    notForSale: false,
    lifecycle: "active",
    lifecycleLabel: "Active",
    buyable: true,
    lifecycleReason: null,
    onOrderUnits: 0,
    expectedArrivalAt: null,
    syncError: null,
    syncErrorAt: null,
    leadDays: 14,
    leadSource: "supplier",
    supplierName: "Haria",
    verdict: "healthy",
    marginPct: 50,
    missingCost: false,
    suspectCost: false,
    heldOffBuyList: false,
    costMovedPct: null,
    costMovedAt: null,
    facet: {
      productId: over.productId ?? "p1",
      brand: "Nice & Lovely",
      productType: null,
      category: null,
      supplier: null,
      supplierGroup: null,
      speedBand: null,
      abc: "A",
      health: [],
    },
    ...over,
  }) as CatalogueRow;

const table = (rows: CatalogueRow[]): DashboardTable => ({
  counts: { stockout: rows.length, reorder: 0, onway: 0, dead: 0, all: rows.length },
  healthy: 0,
  rows: { stockout: rows, reorder: [], onway: [], dead: [], all: rows },
  deadWindowDays: 90,
  deadCostKes: 0,
  criticalCount: 0,
  criticalCostKes: 0,
  capped: { stockout: false, reorder: false, onway: false, dead: false, all: false },
  deadStockExport: [],
});

const render = (rows: CatalogueRow[]) =>
  renderToStaticMarkup(<ProductTabs data={table(rows)} canViewCosts trend={null} />);

describe("dashboard row context", () => {
  it("says an empty shelf has no days left, rather than an unknown number", () => {
    // A dash reads as "we don't know" on exactly the rows where the answer is
    // known and is the most urgent one on the screen.
    const html = render([row({ onHandUnits: 0, daysCover: null })]);
    // Anchored to the cell, not the markup: "0d" appears inside hashed class
    // names, so a bare substring match passes with the rule removed entirely.
    expect(html, "an empty shelf still reports an unknown number of days").toContain(">0d<");
    expect(html).toContain("Days left");
    expect(html, "the column still calls itself Cover").not.toContain(">Cover<");
  });

  it("keeps the dash for something that never runs out", () => {
    // No run rate is not the same as no stock. Printing 0d here would invent an
    // emergency on a product nobody is buying.
    const html = render([row({ onHandUnits: 40, daysCover: null })]);
    expect(html).toContain(">—<");
    expect(html, "a product that never runs out was given a deadline").not.toContain(">0d<");
  });

  it("marks an empty shelf and a nearly-empty one differently", () => {
    const out = render([row({ productId: "a", onHandUnits: 0, urgency: "critical" })]);
    expect(out).toContain(">out<");

    const critical = render([row({ productId: "b", onHandUnits: 3, urgency: "critical" })]);
    expect(critical, "a shelf about to empty is not marked at all").toContain("critical");
    expect(critical).not.toContain(">out<");
  });

  it("leaves a healthy row unmarked", () => {
    // A badge on every row is decoration; the mark has to mean something.
    const html = render([row({ urgency: "low", onHandUnits: 30 })]);
    for (const mark of [">out<", ">critical<", ">low<"]) {
      expect(html, `a healthy row was marked ${mark}`).not.toContain(mark);
    }
    // The ABC badge stays: it says what the product is worth, not how it is
    // doing, and is the one mark a healthy row should carry.
    expect(html).toContain(">A<");
  });

  it("names the brand beside the SKU", () => {
    expect(render([row()])).toContain("Nice &amp; Lovely");
  });
});
