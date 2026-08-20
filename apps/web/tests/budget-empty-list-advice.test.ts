import { describe, expect, it } from "vitest";
import { splitByBudget, type BuyListRow } from "../lib/data/plan";

/**
 * A budget that funded nothing has two very different causes, and the planner
 * gave the same advice to both.
 *
 * On a shop whose buy list was empty, "the budget doesn't reach anything — raise
 * it or clear a critical first" appeared under KES 800K of untouched budget.
 * The budget reached everything; there was simply nothing on the list, because
 * 47 products were held back for missing costs, being too new, or already being
 * on order. The counts below are what lets the screen tell the two apart.
 */

let seq = 0;
function mkRow(over: Partial<BuyListRow> = {}): BuyListRow {
  seq += 1;
  return {
    predictionId: `b-${seq}`,
    productId: `bp-${seq}`,
    sku: `BSKU-${seq}`,
    title: `Budget row ${seq}`,
    vendor: null,
    supplierName: null,
    onHandUnits: 2,
    onOrderUnits: 0,
    daysUntilStockout: 5,
    daysLeftToOrder: 1,
    leadDays: 4,
    orderByDate: new Date("2026-08-20T00:00:00Z"),
    urgency: "critical",
    tier: "order_today",
    recommendedQty: 10,
    orderQty: 10,
    overriddenQty: null,
    runRatePerDay: 1,
    moq: 1,
    leadFloored: false,
    abc: "A",
    category: null,
    unitCostKes: 1000,
    lineTotalKes: 10_000,
    priceKes: 2000,
    reasoning: "",
    explain: null,
    qtySummary: "",
    confidence: null,
    coldStart: null,
    borrowedFromTitle: null,
    plannable: "ok",
    atRiskKes: 100,
    revenue30dKes: 500,
    ...over,
  };
}

describe("the budget split says which of the two nothings happened", () => {
  it("reports an empty incoming list, and how much is held back", () => {
    const split = splitByBudget([], 800_000, { heldBackCount: 47 });
    expect(split.funded).toHaveLength(0);
    // Nothing was waiting — the budget is untouched, not too small.
    expect(split.incomingCount).toBe(0);
    expect(split.heldBackCount).toBe(47);
    expect(split.leftoverKes).toBe(800_000);
  });

  it("reports a budget that genuinely did not stretch", () => {
    // One KES 10,000 line against a KES 500 budget: there WAS something to fund.
    const split = splitByBudget([mkRow()], 500);
    expect(split.funded).toHaveLength(0);
    expect(split.incomingCount).toBe(1);
    expect(split.deferred).toHaveLength(1);
  });

  it("counts every incoming row, funded or not", () => {
    const split = splitByBudget([mkRow(), mkRow(), mkRow()], 10_000);
    expect(split.incomingCount).toBe(3);
    expect(split.funded.length + split.deferred.length).toBe(3);
  });
});
