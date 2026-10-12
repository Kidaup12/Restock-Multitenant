import { describe, expect, it } from "vitest";
import { assignAbc, saleSpanDays } from "../src/abc";
import { pickBestRun } from "../src/latest-run";

describe("upstream forecasting stability", () => {
  it("holds a sales burst at B until positive sales span two weeks", () => {
    const classify = (span: number) => assignAbc([{ id: "sku", revenue: 1000, runRate: 2, saleSpanDays: span }]).sku;
    expect(classify(0)).toBe("B");
    expect(classify(13)).toBe("B");
    expect(classify(14)).toBe("A");
    expect(assignAbc([{ id: "sku", revenue: 1000, runRate: 0.01, saleSpanDays: 20 }]).sku).toBe("C");
  });
  it("excludes zero, future and out-of-window sales from the span", () => {
    const point = (date: string, quantity = 1) => ({ date: new Date(date), quantity });
    expect(saleSpanDays([point("2026-09-01"), point("2026-09-15"), point("2026-09-30", 0), point("2026-10-02"), point("2025-01-01")], new Date("2026-10-01"))).toBe(14);
  });
  it("a small AI remnant cannot displace a full catalogue", () => {
    const runs = [{ forecastRunId: "ai", count: 100 }, { forecastRunId: "full", count: 1300 }];
    expect(pickBestRun(runs, new Set(["ai"]))).toBe("full");
    expect(pickBestRun([{ ...runs[0]!, count: 650 }, runs[1]!], new Set(["ai"]))).toBe("ai");
    expect(pickBestRun([], new Set())).toBeNull();
  });
});
