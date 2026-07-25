import { describe, expect, it } from "vitest";
import { moqPreview, type MoqPreviewInput } from "../lib/plan/moq-preview";

/** Pure MOQ-floor preview: what a supplier minimum does to a buy-list line. */

const row = (over: Partial<MoqPreviewInput> = {}): MoqPreviewInput => ({
  recommendedQty: 10,
  overriddenQty: null,
  moq: 1,
  runRatePerDay: 1,
  ...over,
});

describe("moqPreview", () => {
  it("floors the quantity up to the supplier MOQ and flags the round-up", () => {
    const p = moqPreview(row({ recommendedQty: 10, moq: 48, runRatePerDay: 5 }));
    expect(p.effectiveQty).toBe(10);
    expect(p.flooredQty).toBe(48);
    expect(p.roundedUp).toBe(true);
  });

  it("does not round up when the recommendation already clears the MOQ", () => {
    const p = moqPreview(row({ recommendedQty: 60, moq: 48, runRatePerDay: 2 }));
    expect(p.flooredQty).toBe(60);
    expect(p.roundedUp).toBe(false);
    expect(p.badMoq).toBe(false);
  });

  it("prefers the owner's override over the engine number", () => {
    const p = moqPreview(row({ recommendedQty: 999, overriddenQty: 12, moq: 48 }));
    expect(p.effectiveQty).toBe(12);
    expect(p.flooredQty).toBe(48);
    expect(p.roundedUp).toBe(true);
  });

  it("flags a bad MOQ when the floor buys roughly four-plus months of cover", () => {
    // 48 units at ~9/month (0.3/day * 30) ≈ 5.3 months of cover.
    const p = moqPreview(row({ recommendedQty: 10, moq: 48, runRatePerDay: 0.3 }));
    expect(p.roundedUp).toBe(true);
    expect(p.monthsOfCover).toBeCloseTo(48 / 9, 5);
    expect(p.badMoq).toBe(true);
  });

  it("does not flag when the MOQ floor clears in under four months", () => {
    // 48 units at 150/month (5/day * 30) ≈ 0.3 months of cover.
    const p = moqPreview(row({ recommendedQty: 40, moq: 48, runRatePerDay: 5 }));
    expect(p.roundedUp).toBe(true);
    expect(p.badMoq).toBe(false);
  });

  it("is safe at a zero run rate — no NaN, no cover, no bad flag", () => {
    const p = moqPreview(row({ recommendedQty: 10, moq: 48, runRatePerDay: 0 }));
    expect(p.flooredQty).toBe(48);
    expect(p.roundedUp).toBe(true);
    expect(p.monthsOfCover).toBeNull();
    expect(p.badMoq).toBe(false);
  });
});
