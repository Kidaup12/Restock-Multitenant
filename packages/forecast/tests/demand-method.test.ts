import { describe, expect, it } from "vitest";
import { demandRateFor } from "../src/layered";
import { forecastProduct } from "../src/pipeline";
import { championForClass, resolveChampions } from "../src/config";
import type { SalesPoint } from "../src/baseline";

const today = new Date("2026-08-18T00:00:00.000Z");
const day = (back: number) => new Date(+today - back * 864e5);

/** Sold 2/day for the last 30 days, except the last 10 when the shelf was empty. */
function historyWithEmptyShelf(): { history: SalesPoint[]; emptyDays: Date[] } {
  const history: SalesPoint[] = [];
  for (let back = 30; back > 10; back--) history.push({ date: day(back), quantity: 2 });
  const emptyDays = Array.from({ length: 10 }, (_, i) => day(10 - i));
  return { history, emptyDays };
}

/**
 * Both methods answer the same question — how fast does this sell — and differ
 * only in how they weight recency. A method that also skipped the censoring
 * would look better in the audition purely by counting empty-shelf days as
 * days of no demand, and would then under-buy every product in the class it won.
 */
describe("every demand method censors the same way", () => {
  it("recent_heavy ignores days the shelf was empty", () => {
    const { history, emptyDays } = historyWithEmptyShelf();

    const naive = demandRateFor("recent_heavy", history, today);
    const censored = demandRateFor("recent_heavy", history, today, { stockoutDates: emptyDays });

    // 40 units over a flat 30-day window reads as 1.33/day; with the ten empty
    // days taken out of the denominator it reads as the 2/day it truly sold at.
    expect(naive).toBeCloseTo(40 / 30, 2);
    expect(censored).toBeGreaterThan(naive);
    expect(censored).toBeCloseTo(2, 1);
  });

  it("recent_heavy drops promo and closure days too", () => {
    const { history } = historyWithEmptyShelf();
    const excluded = [day(30), day(29), day(28)];

    const withAll = demandRateFor("recent_heavy", history, today);
    const withoutPromo = demandRateFor("recent_heavy", history, today, { excludedDates: excluded });

    expect(withoutPromo).not.toBeCloseTo(withAll, 5);
  });

  it("defaults to the run rate when no method is named", () => {
    const { history } = historyWithEmptyShelf();
    expect(demandRateFor("run_rate", history, today)).toBeCloseTo(
      demandRateFor("run_rate", history, today),
      10
    );
  });
});

describe("the champion a class won reaches the forecast", () => {
  /** Quiet for months, then busy for the last few weeks — the shape the two
   *  methods disagree about, since one anchors on the long tail and one does not. */
  const history: SalesPoint[] = [
    ...Array.from({ length: 120 }, (_, i) => ({ date: day(180 - i), quantity: 0.2 })),
    ...Array.from({ length: 25 }, (_, i) => ({ date: day(25 - i), quantity: 6 })),
  ];

  const product = {
    sku: "SKU-1",
    productType: null,
    vendor: null,
    currentStock: 50,
    costKes: 100,
    priceKes: 400,
    leadTimeDays: null,
    minStock: null,
    maxStock: null,
  };
  const base = {
    productId: "p1",
    product,
    supplier: null,
    history,
    runDateKey: "2026-08-18",
    abcCategory: "B" as const,
  };

  it("forecasts differently under each method", () => {
    const onRunRate = forecastProduct({ ...base, demandMethod: "run_rate" });
    const onRecentHeavy = forecastProduct({ ...base, demandMethod: "recent_heavy" });
    expect(onRecentHeavy.finalForecast30d).not.toBeCloseTo(onRunRate.finalForecast30d, 2);
  });

  it("uses the run rate when the class has no champion on file", () => {
    const unnamed = forecastProduct({ ...base });
    const explicit = forecastProduct({ ...base, demandMethod: "run_rate" });
    expect(unnamed.finalForecast30d).toBeCloseTo(explicit.finalForecast30d, 10);
  });
});

describe("resolveChampions reads what the audition stored", () => {
  it("takes a stored method per class", () => {
    expect(resolveChampions({ A: "recent_heavy", B: "run_rate", C: "recent_heavy" })).toEqual({
      A: "recent_heavy",
      B: "run_rate",
      C: "recent_heavy",
    });
  });

  it("falls back to the run rate for anything it does not recognise", () => {
    // Nothing audited yet, a stale method name, and the audit's own timestamp
    // sitting alongside the classes.
    expect(resolveChampions(null)).toEqual({ A: "run_rate", B: "run_rate", C: "run_rate" });
    expect(resolveChampions({ A: "croriander", auditedAt: "2026-08-18" })).toEqual({
      A: "run_rate",
      B: "run_rate",
      C: "run_rate",
    });
  });

  it("gives an unclassified product the C class's method", () => {
    const champions = resolveChampions({ A: "run_rate", B: "run_rate", C: "recent_heavy" });
    expect(championForClass(champions, null)).toBe("recent_heavy");
    expect(championForClass(champions, "A")).toBe("run_rate");
  });
});
