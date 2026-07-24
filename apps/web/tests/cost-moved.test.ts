import { describe, expect, it } from "vitest";
import { detectCostMove, formatMovePct } from "@/lib/cost";

/** The >20% synced-cost jump detector — pure. */

describe("detectCostMove", () => {
  it("flags a jump above the threshold", () => {
    const move = detectCostMove({ currentCostKes: 118, lastSyncedCostKes: 100 })!;
    // 18% — under the threshold, not flagged.
    expect(move.pct).toBeCloseTo(18);
    expect(move.exceeded).toBe(false);
  });

  it("flags a rise beyond 20%", () => {
    const move = detectCostMove({ currentCostKes: 130, lastSyncedCostKes: 100 })!;
    expect(move.pct).toBeCloseTo(30);
    expect(move.exceeded).toBe(true);
  });

  it("flags a fall beyond 20% (signed)", () => {
    const move = detectCostMove({ currentCostKes: 70, lastSyncedCostKes: 100 })!;
    expect(move.pct).toBeCloseTo(-30);
    expect(move.exceeded).toBe(true);
  });

  it("exactly 20% is not flagged (threshold is strict)", () => {
    expect(detectCostMove({ currentCostKes: 120, lastSyncedCostKes: 100 })!.exceeded).toBe(false);
  });

  it("no baseline yet → null (first observation)", () => {
    expect(detectCostMove({ currentCostKes: 100, lastSyncedCostKes: null })).toBeNull();
  });

  it("a zero/missing current cost is never a move", () => {
    expect(detectCostMove({ currentCostKes: 0, lastSyncedCostKes: 100 })).toBeNull();
  });

  it("a non-positive baseline can't anchor a percentage", () => {
    expect(detectCostMove({ currentCostKes: 100, lastSyncedCostKes: 0 })).toBeNull();
  });
});

describe("formatMovePct", () => {
  it("signs and rounds", () => {
    expect(formatMovePct(18.4)).toBe("+18%");
    expect(formatMovePct(-22.6)).toBe("-23%");
  });
});
