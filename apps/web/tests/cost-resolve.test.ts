import { describe, expect, it } from "vitest";
import {
  excludeSuspectCost,
  isSuspectCost,
  resolveCost,
  resolveCostChain,
  type StoredCost,
} from "@/lib/cost";

/**
 * The cost priority chain + suspect rule — pure, no database. Proves manual pin
 * wins, zero is treated as missing, the QB seam sits between manual and shopify,
 * and the suspect rule (missing / zero / cost >= price) matches the spec.
 */

describe("resolveCostChain (priority: manual > qb > shopify > missing)", () => {
  it("manual pin wins over qb and shopify", () => {
    expect(resolveCostChain({ manualCostKes: 100, qbCostKes: 200, shopifyCostKes: 300 })).toEqual({
      costKes: 100,
      source: "manual",
    });
  });

  it("qb wins over shopify when there is no manual pin (the seam)", () => {
    expect(resolveCostChain({ manualCostKes: null, qbCostKes: 200, shopifyCostKes: 300 })).toEqual({
      costKes: 200,
      source: "qb",
    });
  });

  it("falls back to shopify unit cost", () => {
    expect(resolveCostChain({ shopifyCostKes: 300 })).toEqual({ costKes: 300, source: "shopify" });
  });

  it("nothing usable → missing", () => {
    expect(resolveCostChain({})).toEqual({ costKes: 0, source: "missing" });
  });

  it("a zero is treated as missing and never wins over a real cost", () => {
    // Manual zero must not shadow a real shopify cost.
    expect(resolveCostChain({ manualCostKes: 0, shopifyCostKes: 300 })).toEqual({
      costKes: 300,
      source: "shopify",
    });
    // All-zero → missing.
    expect(resolveCostChain({ manualCostKes: 0, qbCostKes: 0, shopifyCostKes: 0 })).toEqual({
      costKes: 0,
      source: "missing",
    });
    // Negative is unusable too.
    expect(resolveCostChain({ shopifyCostKes: -5 })).toEqual({ costKes: 0, source: "missing" });
  });
});

describe("resolveCost (stored classifier)", () => {
  const priced = (over: Partial<StoredCost>): StoredCost => ({
    costKes: 100,
    costSource: "shopify",
    priceKes: 250,
    ...over,
  });

  it("labels a healthy shopify cost and holds nothing", () => {
    const r = resolveCost(priced({}));
    expect(r.source).toBe("shopify");
    expect(r.isSuspect).toBe(false);
    expect(r.heldOffBuyList).toBe(false);
  });

  it("keeps the manual label", () => {
    expect(resolveCost(priced({ costSource: "manual" })).source).toBe("manual");
  });

  it("zero cost → missing source, suspect, held off the buy list", () => {
    const r = resolveCost(priced({ costKes: 0, costSource: "shopify" }));
    expect(r.source).toBe("missing");
    expect(r.costKes).toBe(0);
    expect(r.suspectReason).toBe("missing");
    expect(r.isSuspect).toBe(true);
    expect(r.heldOffBuyList).toBe(true);
  });

  it("cost >= price → suspect (cost-ge-price)", () => {
    const r = resolveCost(priced({ costKes: 300, priceKes: 250 }));
    expect(r.isSuspect).toBe(true);
    expect(r.suspectReason).toBe("cost-ge-price");
    expect(r.heldOffBuyList).toBe(true); // cost > price → engine holds it too
  });

  it("cost exactly at price is suspect but not held (the documented knife-edge)", () => {
    const r = resolveCost(priced({ costKes: 250, priceKes: 250 }));
    expect(r.isSuspect).toBe(true); // catalogue flags zero margin
    expect(r.heldOffBuyList).toBe(false); // engine reorders at break-even
  });

  it("a real cost with a blank source label falls back to shopify", () => {
    expect(resolveCost(priced({ costSource: null })).source).toBe("shopify");
  });
});

describe("suspect helpers", () => {
  it("isSuspectCost mirrors the classifier", () => {
    expect(isSuspectCost({ costKes: 0, costSource: null, priceKes: 100 })).toBe(true);
    expect(isSuspectCost({ costKes: 60, costSource: "manual", priceKes: 100 })).toBe(false);
  });

  it("excludeSuspectCost drops missing and cost>=price rows", () => {
    const rows: StoredCost[] = [
      { costKes: 60, costSource: "manual", priceKes: 100 }, // ok
      { costKes: 0, costSource: null, priceKes: 100 }, // missing
      { costKes: 120, costSource: "shopify", priceKes: 100 }, // cost>price
    ];
    expect(excludeSuspectCost(rows)).toHaveLength(1);
    expect(excludeSuspectCost(rows)[0]!.costKes).toBe(60);
  });
});
