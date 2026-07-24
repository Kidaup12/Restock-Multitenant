import { describe, it, expect } from "vitest";
import { explainQty } from "../src/explain";
import { recommendedQty } from "../src/reorder";

describe("explainQty", () => {
  const base = { finalForecast30d: 60, safetyStock: 5, currentStock: 8, onOrder: 3, coverDays: 17 };

  it("breakdown total equals recommendedQty() (single source of truth)", () => {
    const e = explainQty(base);
    expect(e.recommendedQty).toBe(recommendedQty(base));
  });

  it("computes daily forecast = finalForecast30d / 30 and demand over the cover window", () => {
    const e = explainQty(base);
    expect(e.dailyForecast).toBeCloseTo(2, 5); // 60/30
    expect(e.demandOverCover).toBeCloseTo(34, 5); // 2 × 17
  });

  it("subtracts incoming (onOrder) — never re-orders stock in transit", () => {
    const withIncoming = explainQty(base).recommendedQty;
    const noIncoming = explainQty({ ...base, onOrder: 0 }).recommendedQty;
    expect(noIncoming).toBeGreaterThan(withIncoming);
  });

  it("defaults coverDays to 30 when omitted", () => {
    const e = explainQty({ finalForecast30d: 30, safetyStock: 0, currentStock: 0, onOrder: 0 });
    expect(e.coverDays).toBe(30);
    expect(e.demandOverCover).toBeCloseTo(30, 5); // (30/30) × 30
  });

  it("summary string ends with the recommended qty", () => {
    const e = explainQty(base);
    expect(e.summary).toContain(`= ${e.recommendedQty}`);
  });

  it("the total tracks a policy-driven quantity too (never drifts from the UI number)", () => {
    const input = { ...base, dailyDemandStd: 3, leadTimeAvg: 14, policy: { serviceLevel: 0.95, rule: "calibrated" as const } };
    expect(explainQty(input).recommendedQty).toBe(recommendedQty(input));
  });

  it("the breakdown reconciles for EVERY rule — target − on hand − incoming = qty", () => {
    const cases = [
      base, // mean cover (no policy, not C)
      { ...base, dailyDemandStd: 3, leadTimeAvg: 14, policy: { serviceLevel: 0.95, rule: "calibrated" as const } },
      { ...base, abcCategory: "C" }, // min/max
    ];
    for (const input of cases) {
      const e = explainQty(input);
      expect(e.recommendedQty).toBe(recommendedQty(input));
      if (e.recommendedQty > 0) {
        // The printed arithmetic actually adds up — the trust promise.
        expect(e.targetUnits - e.currentStock - e.onOrder).toBe(e.recommendedQty);
      } else {
        expect(e.targetUnits - e.currentStock - e.onOrder).toBeLessThanOrEqual(0);
      }
      expect(e.summary).toContain(`= ${e.recommendedQty}`);
    }
  });

  it("an overridden (held) quantity is stated plainly, not as false arithmetic", () => {
    const e = explainQty({ ...base, abcCategory: "C" }, 0); // pipeline zeroed a dead/too-new item
    expect(e.recommendedQty).toBe(0);
    expect(e.summary).toMatch(/held off the buy list/i);
    expect(e.summary).toContain("= 0");
  });
});
