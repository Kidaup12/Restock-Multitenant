import { describe, expect, it } from "vitest";
import { recommendFor, suggestedDiscountPct, type RecommendationProduct } from "../src/recommendations";

const base: RecommendationProduct = {
  productId: "p", title: "Lotion", abc: "C", category: "Body", onHand: 10,
  costKes: 500, priceKes: 1000, runRate: 0, dead: true, daysSinceSale: 100, plannedQty: 0,
};
const rec = (products: RecommendationProduct[], windowDays = 90) => recommendFor(products, { windowDays });
const actions = (products: RecommendationProduct[]) => rec(products).map((r) => r.action);

describe("recommendations", () => {
  it("ignores stock that is selling at a normal pace, or not there", () => {
    expect(rec([{ ...base, dead: false, runRate: 1, onHand: 30 }])).toEqual([]);
    expect(rec([{ ...base, onHand: 0 }])).toEqual([]);
  });

  it("discounts dead stock by how stale it is, freeing its cash at cost", () => {
    const [r] = rec([base]);
    expect(r).toMatchObject({ action: "discount", idleUnits: 10, cashKes: 5000 });
    expect(r!.payload).toMatchObject({ pct: 20, newPriceKes: 800 });
    expect(rec([{ ...base, daysSinceSale: 140 }])[0]!.payload.pct).toBe(30);
  });

  it("never discounts below cost plus a margin floor", () => {
    expect(suggestedDiscountPct({ ...base, costKes: 900 }, 90)).toBeNull(); // 1000 → floor 945
    expect(suggestedDiscountPct({ ...base, costKes: 800, daysSinceSale: 200 }, 90)).toBe(15); // 30% capped at 16% → 15
  });

  it("counts only the stock beyond 90 days of cover as idle when it still sells", () => {
    const [r] = rec([{ ...base, dead: false, runRate: 0.5, onHand: 100, daysSinceSale: 3 }]);
    expect(r).toMatchObject({ action: "discount", idleUnits: 55, cashKes: 27_500 });
    expect(r!.payload.pct).toBe(10);
  });

  it("says skip the reorder when the plan would buy more of idle stock", () => {
    expect(actions([{ ...base, plannedQty: 6 }]).sort()).toEqual(["discount", "stop_reorder"]);
    expect(rec([{ ...base, plannedQty: 6 }]).find((r) => r.action === "stop_reorder")!.cashKes).toBe(3000);
  });

  it("bundles with the category's best seller when the margin can't fund a discount", () => {
    const star: RecommendationProduct = { ...base, productId: "star", title: "Best Mist", abc: "A", dead: false, runRate: 3, onHand: 20, daysSinceSale: 0 };
    const thin = { ...base, costKes: 950, daysSinceSale: 100 };
    const r = rec([thin, star]).find((x) => x.productId === "p")!;
    expect(r.action).toBe("bundle");
    expect(r.payload).toMatchObject({ pairProductId: "star", pairTitle: "Best Mist" });
  });

  it("suggests a return or clearance when long dead and no discount fits", () => {
    expect(actions([{ ...base, costKes: 950, daysSinceSale: 200, category: null }])).toEqual(["clear"]);
    expect(actions([{ ...base, costKes: 950, daysSinceSale: null, category: null }])).toEqual(["clear"]);
  });

  it("ranks by cash tied up", () => {
    const small = { ...base, productId: "small", onHand: 2 };
    const big = { ...base, productId: "big", onHand: 40 };
    expect(rec([small, big]).map((r) => r.productId)).toEqual(["big", "small"]);
  });
});
