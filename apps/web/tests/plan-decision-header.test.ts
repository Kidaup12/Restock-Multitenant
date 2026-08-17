import { describe, expect, it } from "vitest";
import { planDecisionSummary } from "../app/(shell)/plan/decision-header";
import type { BuyListRow } from "../lib/data/plan";

/**
 * Pure decision-header summary — no database, no React. Counts the "order today"
 * tier, sums the cash to clear urgency-critical lines and the revenue at risk,
 * and keeps a total null when any input it sums is null (a money-blind member's
 * redacted cost fields), rather than coercing the unknown to zero.
 */

let seq = 0;
function mkRow(partial: Partial<BuyListRow>): BuyListRow {
  seq += 1;
  return {
    predictionId: `d-${seq}`,
    productId: `dp-${seq}`,
    sku: `DSKU-${seq}`,
    title: `Decision row ${seq}`,
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

describe("planDecisionSummary (pure)", () => {
  it("counts the order-today tier and totals the whole list", () => {
    const rows = [
      mkRow({ tier: "order_today" }),
      mkRow({ tier: "order_today" }),
      mkRow({ tier: "this_week" }),
      mkRow({ tier: "can_wait" }),
    ];
    const summary = planDecisionSummary(rows);
    expect(summary.orderTodayCount).toBe(2);
    expect(summary.productCount).toBe(4);
  });

  it("sums the cash to clear urgency-critical lines only", () => {
    const rows = [
      mkRow({ urgency: "critical", lineTotalKes: 5000 }),
      mkRow({ urgency: "critical", lineTotalKes: 1500 }),
      mkRow({ urgency: "high", lineTotalKes: 9000 }),
      mkRow({ urgency: "medium", lineTotalKes: 4000 }),
    ];
    // Only the two criticals count: 5000 + 1500. The high/medium lines are excluded.
    expect(planDecisionSummary(rows).criticalsCashKes).toBe(6500);
  });

  it("sums revenue at risk across every row", () => {
    const rows = [
      mkRow({ atRiskKes: 1200 }),
      mkRow({ atRiskKes: 800 }),
      mkRow({ atRiskKes: 0 }),
    ];
    expect(planDecisionSummary(rows).atRiskKes).toBe(2000);
  });

  it("has no criticals cash to clear when nothing is critical (empty sum is 0)", () => {
    const rows = [mkRow({ urgency: "high" }), mkRow({ urgency: "medium" })];
    expect(planDecisionSummary(rows).criticalsCashKes).toBe(0);
  });

  it("keeps the totals null for a money-blind member (redacted cost fields)", () => {
    // The data layer nulls lineTotalKes and atRiskKes for a member; summing those
    // must stay null, never coerce to 0.
    const rows = [
      mkRow({ urgency: "critical", tier: "order_today", lineTotalKes: null, atRiskKes: null }),
      mkRow({ urgency: "medium", lineTotalKes: null, atRiskKes: null }),
    ];
    const summary = planDecisionSummary(rows);
    expect(summary.criticalsCashKes).toBeNull();
    expect(summary.atRiskKes).toBeNull();
    // The non-money figures still resolve for a member.
    expect(summary.orderTodayCount).toBe(1);
    expect(summary.productCount).toBe(2);
  });

  it("nulls the criticals total if even one critical line's cost is hidden", () => {
    const rows = [
      mkRow({ urgency: "critical", lineTotalKes: 5000 }),
      mkRow({ urgency: "critical", lineTotalKes: null }),
    ];
    // A partial sum would understate the cash needed, so the whole total is null.
    expect(planDecisionSummary(rows).criticalsCashKes).toBeNull();
  });

  it("empty list: zero counts, zero criticals cash, zero at risk", () => {
    const summary = planDecisionSummary([]);
    expect(summary).toEqual({
      orderTodayCount: 0,
      criticalsCashKes: 0,
      atRiskKes: 0,
      productCount: 0,
    });
  });
});
