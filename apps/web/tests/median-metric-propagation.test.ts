import { describe, expect, it } from "vitest";
import { runRate } from "../lib/metrics/calc";

describe("catalogue baseline selection", () => {
  it("does not learn an unfinished trading day's bulk total in live rates", () => {
    const asOf = new Date("2026-10-05T12:00:00Z");
    const today = new Date("2026-10-05T00:00:00Z");
    const history = Array.from({ length: 100 }, (_, i) => ({ date: new Date(+today - (i + 1) * 86400000), quantity: 1 }));
    for (const bulk of [false, true]) {
      const expected = runRate(history, asOf, [], history[99]!.date, "mean", bulk);
      expect(runRate([...history, { date: today, quantity: 1000 }], asOf, [], history[99]!.date, "mean", bulk)).toBe(expected);
    }
  });
  it("applies the optional bulk correction to live stock rates without changing sales", () => {
    const asOf = new Date("2026-10-05T00:00:00Z");
    const history = [100, 10, 5].map((days, i) => ({ date: new Date(+asOf - days * 86400000), quantity: i === 2 ? 30 : 1, revenueKes: i === 2 ? 3000 : 100 }));
    const before = structuredClone(history);
    const normal = runRate(history, asOf, [], history[0]!.date, "mean", false);
    const corrected = runRate(history, asOf, [], history[0]!.date, "mean", true);
    expect(corrected).toBeLessThan(normal);
    expect(history).toEqual(before);
    expect(normal).toBe(runRate(history, asOf, [], history[0]!.date, "mean"));
  });
  it("uses selected median while preserving the default damped mean", () => {
    const asOf = new Date("2026-10-05T00:00:00Z");
    const history = Array.from({ length: 364 }, (_, i) => ({
      date: new Date(+asOf - (i + 1) * 86400000), quantity: i < 7 ? 30 : 1,
    }));
    const since = history[363]!.date;
    expect(runRate(history, asOf, [], since, "median")).toBeCloseTo(1);
    expect(runRate(history, asOf, [], since)).toBeGreaterThan(1);
    expect(runRate(history, asOf, [], since, "mean")).toBe(runRate(history, asOf, [], since));
  });
});
