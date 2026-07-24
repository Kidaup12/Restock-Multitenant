import { describe, it, expect } from "vitest";
import {
  walkForwardBacktest,
  walkForwardCutoffs,
  methodDailyRate,
  auditChampion,
  championsByClass,
  CHALLENGER_WIN_MARGIN,
  type BacktestProduct,
  type ClassAccuracy,
  type DemandMethod,
} from "../src/backtest";
import type { SalesPoint } from "../src/baseline";

const DAY = 86_400_000;
const base = new Date("2026-07-24T00:00:00Z");
const at = (daysAgo: number, quantity: number): SalesPoint => ({
  date: new Date(base.getTime() - daysAgo * DAY),
  quantity,
});

/** ~120 days of steady 3-a-day history. */
function steadyHistory(days = 120, rate = 3): SalesPoint[] {
  const out: SalesPoint[] = [];
  for (let d = days; d >= 0; d--) out.push(at(d, rate));
  return out;
}

describe("walkForwardCutoffs", () => {
  it("leaves training history behind and a full horizon ahead of each cutoff", () => {
    const history = steadyHistory(120);
    const cutoffs = walkForwardCutoffs(history, 30, { minTrainDays: 30, step: 15, maxWindows: 4 });
    expect(cutoffs.length).toBeGreaterThan(0);
    const earliest = history[0]!.date.getTime();
    const latest = history[history.length - 1]!.date.getTime();
    for (const c of cutoffs) {
      expect(c.getTime()).toBeGreaterThanOrEqual(earliest + 30 * DAY);
      expect(c.getTime() + 30 * DAY).toBeLessThanOrEqual(latest + DAY);
    }
  });

  it("keeps only the most recent windows past the cap", () => {
    const cutoffs = walkForwardCutoffs(steadyHistory(300), 30, { maxWindows: 3 });
    expect(cutoffs.length).toBe(3);
  });

  it("returns nothing for empty history", () => {
    expect(walkForwardCutoffs([], 30)).toEqual([]);
  });
});

describe("methodDailyRate", () => {
  it("forecasts from history strictly before the cutoff", () => {
    const history = steadyHistory(120, 3);
    const cutoff = new Date(base.getTime() - 30 * DAY);
    expect(methodDailyRate("run_rate", history, cutoff)).toBeGreaterThan(0);
    expect(methodDailyRate("recent_heavy", history, cutoff)).toBeCloseTo(3, 1);
  });
});

describe("walkForwardBacktest", () => {
  it("scores said-vs-happened in units by class, with an ALL rollup", () => {
    // Full 400-day history so the 30/90/365 blend is accurate (a shorter history
    // dilutes the 365 window and mildly under-forecasts — see the next test).
    const products: BacktestProduct[] = [
      { productId: "a", abcClass: "A", history: steadyHistory(400, 5) },
      { productId: "c", abcClass: "C", history: steadyHistory(400, 1) },
    ];
    const cutoffs = walkForwardCutoffs(products[0]!.history, 30, { maxWindows: 3 });
    const result = walkForwardBacktest(products, cutoffs, 30);

    const all = result.byClass.filter((r) => r.abcClass === "ALL");
    expect(all.length).toBe(2); // one per method
    for (const row of all) {
      expect(row.sampleSize).toBeGreaterThan(0);
      expect(row.happenedUnits).toBeGreaterThan(0);
      expect(row.saidUnits).toBeGreaterThan(0);
      expect(row.mae).toBeGreaterThanOrEqual(0);
      expect(["over", "under", "even"]).toContain(row.leans);
    }

    // A-class steady demand on a full history: forecast is close, leans "even".
    const aRun = result.byClass.find((r) => r.abcClass === "A" && r.method === "run_rate")!;
    expect(aRun.leans).toBe("even");
  });

  it("a rising product leans 'under' (run rate lags growth)", () => {
    const rising: SalesPoint[] = [];
    for (let d = 120; d >= 0; d--) rising.push(at(d, Math.max(1, Math.round((120 - d) / 10))));
    const cutoffs = walkForwardCutoffs(rising, 30, { maxWindows: 3 });
    const result = walkForwardBacktest([{ productId: "r", abcClass: "A", history: rising }], cutoffs, 30);
    const run = result.byClass.find((r) => r.abcClass === "A" && r.method === "run_rate")!;
    expect(run.leans).toBe("under");
  });
});

const acc = (method: DemandMethod, mae: number, sampleSize = 12): ClassAccuracy => ({
  abcClass: "A",
  method,
  saidUnits: 100,
  happenedUnits: 100,
  mae,
  bias: 0,
  mape: 0.1,
  sampleSize,
  leans: "even",
});

describe("auditChampion — run rate reigns until a real win", () => {
  it("keeps run rate when no challenger clears the margin", () => {
    // challenger only 5% better; margin is 10%.
    expect(auditChampion({ run_rate: acc("run_rate", 10), recent_heavy: acc("recent_heavy", 9.5) })).toBe("run_rate");
  });

  it("switches only when a challenger beats run rate by the full margin", () => {
    expect(auditChampion({ run_rate: acc("run_rate", 10), recent_heavy: acc("recent_heavy", 8) })).toBe("recent_heavy");
    // exactly on the boundary does not switch (strictly better than baseline*(1-margin))
    const boundary = 10 * (1 - CHALLENGER_WIN_MARGIN);
    expect(auditChampion({ run_rate: acc("run_rate", 10), recent_heavy: acc("recent_heavy", boundary) })).toBe("run_rate");
  });

  it("keeps run rate when the challenger is worse", () => {
    expect(auditChampion({ run_rate: acc("run_rate", 10), recent_heavy: acc("recent_heavy", 12) })).toBe("run_rate");
  });

  it("ignores a challenger with no samples", () => {
    expect(auditChampion({ run_rate: acc("run_rate", 10), recent_heavy: acc("recent_heavy", 1, 0) })).toBe("run_rate");
  });

  it("defaults to run rate when there is no baseline at all", () => {
    expect(auditChampion({})).toBe("run_rate");
  });
});

describe("championsByClass", () => {
  it("returns a champion for every class", () => {
    const result = walkForwardBacktest(
      [
        { productId: "a", abcClass: "A", history: steadyHistory(120, 5) },
        { productId: "b", abcClass: "B", history: steadyHistory(120, 2) },
        { productId: "c", abcClass: "C", history: steadyHistory(120, 1) },
      ],
      walkForwardCutoffs(steadyHistory(120), 30, { maxWindows: 3 }),
      30
    );
    const champs = championsByClass(result);
    expect(Object.keys(champs).sort()).toEqual(["A", "B", "C"]);
    for (const c of Object.values(champs)) expect(["run_rate", "recent_heavy"]).toContain(c);
  });
});
