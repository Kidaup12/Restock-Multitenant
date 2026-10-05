import { describe, expect, it } from "vitest";
import { demandRateFor, layeredForecast, runRateDaily } from "../src/layered";
import { debulkSeries } from "../src/big-buyer";
import { forecastProduct } from "../src/pipeline";
import { methodDailyRate, walkForwardBacktest } from "../src/backtest";

const today = new Date("2026-10-05T00:00:00Z");
const day = (back: number) => new Date(+today - back * 86400000);
// Recent typical demand rose from 1 to 4. The global historical median bulk
// cap (5) and existing last-month spike cap (8) now differ observably; a flat
// series would hide whether this control was wired because the latter wins.
const history = () => Array.from({ length: 364 }, (_, i) => ({
  date: day(i + 1), quantity: i === 0 ? 50 : i < 30 ? 4 : 1,
  revenueKes: (i === 0 ? 50 : i < 30 ? 4 : 1) * 100,
  channel: "pos",
}));

describe("bulk control through forecast consumers", () => {
  it.each([false, true])("keeps unfinished and future bulk sales out of fitting and guardrails (enabled=%s)", (bigBuyerDamping) => {
    const sales = history();
    const input = { productId: "sku", product: { sku: "sku", currentStock: 0, onOrder: 0 },
      supplier: { leadTimeAvgDays: 14, leadTimeStdDays: 2 },
      history: sales, runDateKey: "2026-10-05", abcCategory: "C", bigBuyerDamping };
    const complete = forecastProduct(input);
    const withUnfinished = forecastProduct({ ...input, history: [...sales,
      { date: day(0), quantity: 1000, revenueKes: 100000, channel: "pos" },
      { date: day(-1), quantity: 1000, revenueKes: 100000, channel: "pos" },
    ] });
    expect(withUnfinished).toEqual(complete);
  });
  it("propagates to both rate entrypoints and leaves the disabled default unchanged", () => {
    const sales = history();
    const before = structuredClone(sales);
    const defaultRate = runRateDaily(sales, today);
    const cleaned = runRateDaily(sales, today, undefined, undefined, undefined, "mean", true);
    expect(cleaned).toBeLessThan(defaultRate);
    expect(defaultRate - cleaned).toBeCloseTo(0.05);
    expect(runRateDaily(sales, today, undefined, undefined, undefined, "mean", false)).toBe(defaultRate);
    expect(demandRateFor("run_rate", sales, today, { bigBuyerDamping: true })).toBeCloseTo(cleaned);
    expect(demandRateFor("recent_heavy", sales, today, { bigBuyerDamping: true })).toBeLessThan(demandRateFor("recent_heavy", sales, today));
    expect(sales).toEqual(before);
  });

  it("reaches forecastProduct without rewriting actual quantities or ABC revenue", () => {
    const sales = history();
    const before = structuredClone(sales);
    const input = { productId: "sku", product: { sku: "sku", currentStock: 0, onOrder: 0 },
      history: sales, runDateKey: "2026-10-05", abcCategory: "C" };
    const normal = forecastProduct(input);
    const cleaned = forecastProduct({ ...input, bigBuyerDamping: true });
    expect(cleaned.layer1Forecast30d).toBeLessThan(normal.layer1Forecast30d);
    expect(normal.layer1Forecast30d - cleaned.layer1Forecast30d).toBeCloseTo(1.5);
    expect(sales).toEqual(before);
    expect(sales[0]!.revenueKes).toBe(5000);
  });

  it("cleans training data only in walk-forward and preserves actual holdout bulk units", () => {
    const training = history();
    const holdout = Array.from({ length: 30 }, (_, i) => ({ date: day(-i), quantity: i === 0 ? 500 : 1 }));
    const sales = [...training, ...holdout];
    const expected = demandRateFor("run_rate", training, today, { bigBuyerDamping: true });
    expect(methodDailyRate("run_rate", sales, today, "mean", true)).toBeCloseTo(expected);
    const products = [{ productId: "sku", abcClass: "C" as const, history: sales }];
    const normal = walkForwardBacktest(products, [today], 30);
    const cleaned = walkForwardBacktest(products, [today], 30, { bigBuyerDamping: true });
    const row = cleaned.byClass.find((r) => r.abcClass === "ALL" && r.method === "run_rate")!;
    expect(row.saidUnits).toBeCloseTo(expected * 30);
    expect(row.happenedUnits).toBe(529);
    expect(row.saidUnits).toBeLessThan(normal.byClass.find((r) => r.abcClass === "ALL" && r.method === "run_rate")!.saidUnits);
  });

  it("uses cleaned demand for variability and safety stock, not only the baseline rate", () => {
    const sales = history();
    const clean = debulkSeries(sales, { asOf: today }).series;
    const input = { productId: "sku", sku: "sku", productType: null, vendor: null,
      currentStock: 0, abcCategory: "C", leadTimeAvg: 14, leadTimeStd: 2,
      activePromos: [], runDateKey: "2026-10-05", history: sales };
    const selected = layeredForecast({ ...input, bigBuyerDamping: true });
    const reference = layeredForecast({ ...input, history: clean });
    expect(reference.demandStd).toBeDefined();
    expect(selected.demandStd).toBeCloseTo(reference.demandStd!);
    expect(selected.safetyStock).toBeCloseTo(reference.safetyStock);
    expect(selected.layer1Confidence).toBeCloseTo(reference.layer1Confidence);
  });
});
