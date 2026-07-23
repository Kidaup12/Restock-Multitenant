import { describe, it, expect } from "vitest";
import { overstockExcess } from "../src/overstock";

describe("overstockExcess", () => {
  it("is not overstock when there are no sales (rate 0) — that's dead stock, not overstock", () => {
    const r = overstockExcess({ currentStock: 100, dailyRate: 0, costKes: 50, thresholdDays: 90 });
    expect(r.isOverstock).toBe(false);
    expect(r.excessValueKes).toBe(0);
  });
  it("is not overstock when cover is within the threshold", () => {
    // 90 units at 1/day = 90 days cover, threshold 90 → not over
    const r = overstockExcess({ currentStock: 90, dailyRate: 1, costKes: 50, thresholdDays: 90 });
    expect(r.isOverstock).toBe(false);
  });
  it("flags overstock and computes excess units × cost beyond the threshold", () => {
    // 200 units at 1/day = 200 days cover; threshold 90 → excess 110 units × 50 = 5500
    const r = overstockExcess({ currentStock: 200, dailyRate: 1, costKes: 50, thresholdDays: 90 });
    expect(r.isOverstock).toBe(true);
    expect(r.coverDays).toBe(200);
    expect(r.excessUnits).toBe(110);
    expect(r.excessValueKes).toBe(5500);
  });
});
