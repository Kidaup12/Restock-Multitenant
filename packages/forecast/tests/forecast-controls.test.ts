import { describe, expect, it } from "vitest";
import { assignAbc, resolveAbcWindowDays, saleSpanDays, trailingRevenue } from "../src/abc";
import { methodDailyRate, walkForwardBacktest } from "../src/backtest";

const today = new Date("2026-10-05T00:00:00Z");
const day = (back: number) => new Date(+today - back * 86400000);

describe("upstream forecast controls", () => {
  it("accepts the supported ABC windows and keeps legacy/invalid values on 90 days", () => {
    for (const value of [30, 60, 90] as const) expect(resolveAbcWindowDays(value)).toBe(value);
    for (const value of [undefined, null, 0, -1, 45, 365, NaN]) expect(resolveAbcWindowDays(value)).toBe(90);
  });

  it("uses the selected ABC period for revenue ranking and stability together", () => {
    const oldLeader = [{ date: day(80), quantity: 10, revenueKes: 1000 }, { date: day(40), quantity: 10, revenueKes: 1000 }];
    const newLeader = [{ date: day(20), quantity: 10, revenueKes: 500 }, { date: day(1), quantity: 10, revenueKes: 500 }];
    const classify = (window: number) => assignAbc([oldLeader, newLeader].map((history, i) => ({
      id: String(i), revenue: trailingRevenue(history, today, window),
      saleSpanDays: saleSpanDays(history, today, window), runRate: 1,
    })));
    expect(classify(resolveAbcWindowDays(30))).toEqual({ "0": "C", "1": "A" });
    expect(classify(resolveAbcWindowDays(60))).toEqual({ "0": "B", "1": "A" });
    expect(classify(resolveAbcWindowDays(90))).toEqual({ "0": "A", "1": "A" });
  });

  it("propagates owner median through walk-forward predictions without holdout leakage", () => {
    const training = Array.from({ length: 364 }, (_, i) => ({ date: day(i + 1), quantity: i < 7 ? 30 : 1 }));
    const holdout = Array.from({ length: 30 }, (_, i) => ({ date: day(-i), quantity: 1 }));
    const history = [...training, ...holdout];
    expect(methodDailyRate("run_rate", [...history, { date: day(-10), quantity: 10000 }], today, "median")).toBeCloseTo(1);
    const products = [{ productId: "sku", abcClass: "C" as const, history }];
    const selected = walkForwardBacktest(products, [today], 30, { baselineMethod: "median" });
    const originalDefault = walkForwardBacktest(products, [today], 30);
    for (const row of selected.byClass) {
      expect(row.saidUnits).toBeCloseTo(30);
      expect(row.happenedUnits).toBe(30);
      expect(row.mae).toBeCloseTo(0);
    }
    expect(originalDefault.byClass.find((row) => row.abcClass === "ALL" && row.method === "run_rate")!.saidUnits).toBeGreaterThan(30);
  });
});
