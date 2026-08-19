import { describe, expect, it } from "vitest";
import { preflight } from "../app/(shell)/plan/preflight-strip";
import type { BuyListRow } from "../lib/data/plan";

/**
 * The pre-order checks, pure — no database, no React. Each check is a reason a
 * quantity or a date on the buy list can't be trusted yet, and every one of them
 * reads a field a money-blind member can see, so the strip says the same thing
 * to both roles.
 */

let seq = 0;
function mkRow(partial: Partial<BuyListRow> = {}): BuyListRow {
  seq += 1;
  return {
    predictionId: `p-${seq}`,
    productId: `pp-${seq}`,
    sku: `PSKU-${seq}`,
    title: `Preflight row ${seq}`,
    vendor: null,
    supplierName: "Named Supplier",
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

describe("preflight (pure)", () => {
  it("a clean plan raises nothing", () => {
    expect(preflight([mkRow(), mkRow()]).checks).toEqual([]);
  });

  it("counts stock already on the way as context, not a warning", () => {
    const result = preflight([mkRow({ onOrderUnits: 12 }), mkRow({ onOrderUnits: 0 })]);
    expect(result.onTheWay).toBe(1);
    expect(result.checks).toEqual([]);
  });

  it("flags a negative stock count and sends the owner to Products", () => {
    const [check, ...rest] = preflight([mkRow({ onHandUnits: -3 }), mkRow()]).checks;
    expect(rest).toEqual([]);
    // The count is the concrete part — "some products" is not actionable.
    expect(check.text).toContain("1 product has");
    expect(check.text).toContain("negative stock count");
    expect(check.href).toBe("/products");
  });

  it("flags products with no supplier, because their order-by dates are guesses", () => {
    const check = preflight([mkRow({ supplierName: null }), mkRow({ supplierName: null })])
      .checks[0];
    expect(check.text).toContain("2 products have");
    expect(check.text).toContain("estimates");
    expect(check.href).toBe("/suppliers");
  });

  it("flags a product already sitting on a draft purchase order", () => {
    const check = preflight([mkRow({ doubleOrderWarn: true })]).checks[0];
    expect(check.text).toContain("draft purchase order");
    expect(check.text).toContain("double up");
    expect(check.href).toBe("/orders");
  });

  it("raises every failing check at once, in fix-first order", () => {
    const checks = preflight([
      mkRow({ onHandUnits: -1 }),
      mkRow({ supplierName: null }),
      mkRow({ doubleOrderWarn: true }),
    ]).checks;
    expect(checks.map((c) => c.href)).toEqual(["/products", "/suppliers", "/orders"]);
  });

  it("reads only fields a money-blind member can see", () => {
    // Same rows, costs redacted the way the data layer redacts them. The checks
    // must be identical — a warning that appears only for an owner would make
    // the two roles disagree about whether the list is safe to order.
    const rows = [mkRow({ onHandUnits: -2 }), mkRow({ supplierName: null })];
    const blind = rows.map((r) => ({ ...r, unitCostKes: null, lineTotalKes: null, atRiskKes: null }));
    expect(preflight(blind)).toEqual(preflight(rows));
  });
});
