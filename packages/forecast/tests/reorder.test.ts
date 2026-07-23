import { describe, it, expect } from "vitest";
import { recommendedQty, reorderMethod } from "../src/reorder";

describe("recommendedQty", () => {
  it("subtracts on-order from the gap", () => {
    // gap = 100 + 20 - 30 - 50 = 40
    expect(recommendedQty({
      finalForecast30d: 100,
      safetyStock: 20,
      currentStock: 30,
      onOrder: 50,
    })).toBe(40);
  });

  it("ceil-rounds the natural case (10 + 5 - 3 - 0 = 12)", () => {
    expect(recommendedQty({
      finalForecast30d: 10,
      safetyStock: 5,
      currentStock: 3,
      onOrder: 0,
    })).toBe(12);
  });

  it("floors at zero when on-order alone covers demand", () => {
    // 10 + 5 - 3 - 20 = -8 -> 0
    expect(recommendedQty({
      finalForecast30d: 10,
      safetyStock: 5,
      currentStock: 3,
      onOrder: 20,
    })).toBe(0);
  });

  it("floors at zero when currentStock + onOrder exceeds demand + safety", () => {
    expect(recommendedQty({
      finalForecast30d: 50,
      safetyStock: 10,
      currentStock: 40,
      onOrder: 30,
    })).toBe(0);
  });

  it("floors at zero when stock alone exceeds demand", () => {
    expect(recommendedQty({
      finalForecast30d: 10,
      safetyStock: 5,
      currentStock: 200,
      onOrder: 0,
    })).toBe(0);
  });

  it("ceilings fractional quantities up", () => {
    expect(recommendedQty({
      finalForecast30d: 10.1,
      safetyStock: 0,
      currentStock: 0,
      onOrder: 0,
    })).toBe(11);
  });

  it("on-order alone covers demand -> recommends 0", () => {
    expect(recommendedQty({
      finalForecast30d: 50,
      safetyStock: 10,
      currentStock: 0,
      onOrder: 60,
    })).toBe(0);
  });

  it("returns a non-negative integer in natural cases", () => {
    const r = recommendedQty({
      finalForecast30d: 33.4,
      safetyStock: 5.7,
      currentStock: 10,
      onOrder: 2,
    });
    expect(r).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(r)).toBe(true);
  });

  describe("coverDays (order-cover window)", () => {
    it("defaults to 30 — identical math when omitted", () => {
      const base = { finalForecast30d: 100, safetyStock: 20, currentStock: 30, onOrder: 50 };
      expect(recommendedQty(base)).toBe(recommendedQty({ ...base, coverDays: 30 }));
    });

    it("a 17d cover scales demand down (100/30*17=56.7 +20 -30 -0 = 47)", () => {
      expect(recommendedQty({
        finalForecast30d: 100,
        safetyStock: 20,
        currentStock: 30,
        onOrder: 0,
        coverDays: 17,
      })).toBe(47);
    });

    it("a 21d cover (100/30*21=70 +20 -30 -0 = 60)", () => {
      expect(recommendedQty({
        finalForecast30d: 100,
        safetyStock: 20,
        currentStock: 30,
        onOrder: 0,
        coverDays: 21,
      })).toBe(60);
    });

    it("still subtracts on-order under a cover window", () => {
      expect(recommendedQty({
        finalForecast30d: 100,
        safetyStock: 0,
        currentStock: 0,
        onOrder: 60,
        coverDays: 17, // 56.67 - 60 -> 0
      })).toBe(0);
    });
  });

  describe("calibrated rule (policy-driven)", () => {
    const calInput = {
      finalForecast30d: 60, // 2/day
      safetyStock: 10,
      currentStock: 0,
      onOrder: 0,
      coverDays: 21,
      leadTimeAvg: 14, // protection = 14 + 7 review = 21 days
      dailyDemandStd: 3, // over-dispersed
    };
    const calibrated95 = { serviceLevel: 0.95, rule: "calibrated" as const };

    it("no policy → mean-cover math unchanged", () => {
      // legacy: 60/30*21 + 10 = 52
      expect(recommendedQty(calInput)).toBe(52);
    });

    it("calibrated policy without demand std falls back to mean-cover", () => {
      const { dailyDemandStd, ...noStd } = calInput;
      void dailyDemandStd;
      expect(recommendedQty({ ...noStd, policy: calibrated95 })).toBe(52);
    });

    it("uses the calibrated cover quantile when the policy asks for it", () => {
      const q = recommendedQty({ ...calInput, policy: calibrated95 });
      // p95 of ~42-mean (2/day × 21) over-dispersed demand exceeds the mean-cover 52.
      expect(q).toBeGreaterThan(52);
      expect(Number.isInteger(q)).toBe(true);
    });

    it("covers a longer lead time with more stock (protects until the restock lands)", () => {
      const shortLead = recommendedQty({ ...calInput, leadTimeAvg: 3, policy: calibrated95 }); // protection 10d
      const longLead = recommendedQty({ ...calInput, leadTimeAvg: 28, policy: calibrated95 }); // protection 35d
      expect(longLead).toBeGreaterThan(shortLead);
    });

    it("unknown lead protects the review cycle only — never a guessed horizon", () => {
      const known = recommendedQty({ ...calInput, policy: calibrated95 });
      const { leadTimeAvg, ...unknownLead } = calInput;
      void leadTimeAvg;
      const unknown = recommendedQty({ ...unknownLead, policy: calibrated95 });
      expect(unknown).toBeLessThan(known);
    });

    it("per-class default tau services A higher than B when the policy has no level", () => {
      const openPolicy = { serviceLevel: null, rule: "calibrated" as const };
      const a = recommendedQty({ ...calInput, abcCategory: "A", policy: openPolicy });
      const b = recommendedQty({ ...calInput, abcCategory: "B", policy: openPolicy });
      expect(a).toBeGreaterThan(b);
    });
  });

  describe("per-class method policy (merchant's settings choice)", () => {
    const base = {
      finalForecast30d: 60, // 2/day
      safetyStock: 10,
      currentStock: 0,
      onOrder: 0,
      coverDays: 21,
      leadTimeAvg: 14, // protection = 21 days
      dailyDemandStd: 3,
    };

    it("calibrated cover at 95% over an over-dispersed horizon exceeds mean+safety", () => {
      const calibrated = recommendedQty({ ...base, policy: { serviceLevel: 0.95, rule: "calibrated" } });
      const legacy = recommendedQty(base); // 60/30*21 + 10 = 52
      expect(legacy).toBe(52);
      expect(calibrated).toBeGreaterThan(legacy);
    });

    it("min_max policy forces par top-up even for an A-class SKU", () => {
      // par = ceil(2/day * 14 + 10) = 38; gap = 38 - 0 - 0
      const qty = recommendedQty({ ...base, abcCategory: "A", policy: { serviceLevel: null, rule: "min_max" } });
      expect(qty).toBe(38);
    });

    it("stay_in_stock (0.95) orders more than balanced (0.90) for the same SKU", () => {
      const stay = recommendedQty({ ...base, policy: { serviceLevel: 0.95, rule: "calibrated" } });
      const balanced = recommendedQty({ ...base, policy: { serviceLevel: 0.90, rule: "calibrated" } });
      expect(stay).toBeGreaterThan(balanced);
    });

    it("calibrated policy overrides a C class that would otherwise be min/max", () => {
      const qty = recommendedQty({ ...base, abcCategory: "C", policy: { serviceLevel: 0.95, rule: "calibrated" } });
      const parQty = recommendedQty({ ...base, abcCategory: "C" }); // no policy: C = min/max
      expect(qty).not.toBe(parQty);
    });

    it("C without a policy uses the min/max par rule", () => {
      // par = ceil(2*14 + 10) = 38
      expect(recommendedQty({ ...base, abcCategory: "C" })).toBe(38);
    });
  });
});

describe("reorderMethod", () => {
  it("policy decides when present", () => {
    expect(reorderMethod("A", { rule: "min_max" })).toBe("min_max");
    expect(reorderMethod("C", { rule: "calibrated" })).toBe("forecast");
  });
  it("without a policy, C is min/max and the rest forecast", () => {
    expect(reorderMethod("C")).toBe("min_max");
    expect(reorderMethod("A")).toBe("forecast");
    expect(reorderMethod(null)).toBe("forecast");
  });
});
