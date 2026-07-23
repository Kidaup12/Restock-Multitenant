import { describe, it, expect } from "vitest";
import {
  weightedDailyRate,
  weightedDailyRateAdjusted,
  weightedDailyRateCensored,
  censoredDaysInWindow,
  effectiveWindowDays,
  hasStockoutGap,
  daysOfStockRemaining,
  kingsSafetyStock,
  reorderPoint,
  standardDeviation,
  urgencyFromDays,
  zForServiceLevel,
  SERVICE_Z_DEFAULTS,
} from "../src/baseline";

const TODAY = new Date("2026-07-21T00:00:00Z");
const day = (daysAgo: number) => new Date(+TODAY - daysAgo * 864e5);

describe("weightedDailyRate", () => {
  it("returns 0 for empty history", () => {
    expect(weightedDailyRate([], TODAY)).toBe(0);
  });

  it("blends 30/90/365 windows with recency weighting", () => {
    // 30 units in the last 30 days, nothing older.
    const history = Array.from({ length: 30 }, (_, i) => ({ date: day(i + 1), quantity: 1 }));
    // 30d: 1.0×0.5 + 90d: (30/90)×0.3 + 365d: (30/365)×0.2
    const expected = 1 * 0.5 + (30 / 90) * 0.3 + (30 / 365) * 0.2;
    expect(weightedDailyRate(history, TODAY)).toBeCloseTo(expected, 6);
  });
});

describe("weightedDailyRateCensored", () => {
  it("divides by in-stock days: sold 20 while on shelf 10 of 30 days → ~2/day, not 0.67", () => {
    // 20 units across the 10 most recent days; the 20 days before that were out of stock.
    const history = [
      { date: day(400), quantity: 1 }, // old anchor so the 30d window dominates weighting
      ...Array.from({ length: 10 }, (_, i) => ({ date: day(i + 1), quantity: 2 })),
    ];
    const stockouts = Array.from({ length: 20 }, (_, i) => day(i + 11));
    const rate = weightedDailyRateCensored(history, stockouts, TODAY);
    // 30d window: 20 units / (30-20)=10 days = 2.0 × 0.5 weight = 1.0 dominates
    expect(rate).toBeGreaterThan(1.0);
    const uncensored = weightedDailyRateCensored(history, [], TODAY);
    expect(rate).toBeGreaterThan(uncensored * 1.8); // materially faster than the naive rate
  });

  it("empty mask falls back to the gap-inference variant exactly", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ date: day(i * 3 + 1), quantity: 3 }));
    expect(weightedDailyRateCensored(history, [], TODAY)).toBe(weightedDailyRateAdjusted(history, TODAY));
  });

  it("floors the denominator — 28 censored days can't explode the rate", () => {
    const history = [{ date: day(1), quantity: 10 }, { date: day(200), quantity: 1 }];
    const stockouts = Array.from({ length: 28 }, (_, i) => day(i + 2));
    const censored30 = censoredDaysInWindow(stockouts, day(30), TODAY);
    expect(censored30).toBe(28);
    // one sale-day is not a consistent signal → 7-day floor, not 30-28=2
    const rate = weightedDailyRateCensored(history, stockouts, TODAY);
    expect(rate).toBeLessThan((10 / 2) * 0.5 + 1); // far below the un-floored blowup
  });
});

describe("effectiveWindowDays", () => {
  it("subtracts stockout days with a 7-day floor (no signal)", () => {
    expect(effectiveWindowDays(30, 0)).toBe(30);
    expect(effectiveWindowDays(30, 12)).toBe(18);
    expect(effectiveWindowDays(30, 28)).toBe(7);
    expect(effectiveWindowDays(5, 4)).toBe(5); // window shorter than floor → whole window
  });

  it("adaptive floor: a near-total stockout that sold CONSISTENTLY gets a tight (3d) floor", () => {
    // Out 27 of 30 days → 3 in-stock days, sold on all 3 → real ~1/day seller.
    expect(effectiveWindowDays(30, 27, { inStockDays: 3, saleDays: 3 })).toBe(3);
  });

  it("adaptive floor does NOT trigger on a one-off (only 1 sale-day)", () => {
    expect(effectiveWindowDays(30, 27, { inStockDays: 3, saleDays: 1 })).toBe(7);
  });

  it("adaptive floor does NOT trigger when sales are sparse across in-stock days", () => {
    // In stock 10 days, sold on only 3 (30% < 60%) → thin signal.
    expect(effectiveWindowDays(30, 20, { inStockDays: 10, saleDays: 3 })).toBe(10);
    expect(effectiveWindowDays(30, 25, { inStockDays: 5, saleDays: 1 })).toBe(7);
  });

  it("never goes below the in-stock day count", () => {
    expect(effectiveWindowDays(30, 5, { inStockDays: 25, saleDays: 25 })).toBe(25);
  });
});

describe("hasStockoutGap", () => {
  it("detects a long gap in an otherwise steady seller", () => {
    // ~0.8/day across the year (above the "normally sells" threshold) with a
    // 30-day hole between the two runs.
    const history = [
      ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 1), quantity: 5 })),
      ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 61), quantity: 5 })),
    ];
    expect(hasStockoutGap(history, TODAY)).toBe(true);
  });

  it("no gap on a continuous seller", () => {
    const history = Array.from({ length: 60 }, (_, i) => ({ date: day(i + 1), quantity: 5 }));
    expect(hasStockoutGap(history, TODAY)).toBe(false);
  });
});

describe("inventory primitives", () => {
  it("daysOfStockRemaining: no rate → 999 (never divide by ~0)", () => {
    expect(daysOfStockRemaining(50, 0)).toBe(999);
    expect(daysOfStockRemaining(50, 2)).toBe(25);
  });

  it("kingsSafetyStock buffers both demand and lead-time variability", () => {
    // demandStd 0: variance = demandAvg² × leadStd² → z × demandAvg × leadStd
    expect(kingsSafetyStock({ z: 2, leadTimeAvg: 10, leadTimeStd: 3, demandAvg: 4, demandStd: 0 }))
      .toBeCloseTo(2 * 4 * 3, 6);
    // leadStd 0: variance = leadAvg × demandStd² → z × demandStd × sqrt(leadAvg)
    expect(kingsSafetyStock({ z: 2, leadTimeAvg: 9, leadTimeStd: 0, demandAvg: 4, demandStd: 5 }))
      .toBeCloseTo(2 * 5 * 3, 6);
  });

  it("reorderPoint = demand over lead + safety", () => {
    expect(reorderPoint(2, 10, 15)).toBe(35);
  });

  it("standardDeviation of a constant series is 0; empty is 0", () => {
    expect(standardDeviation([3, 3, 3])).toBe(0);
    expect(standardDeviation([])).toBe(0);
  });
});

describe("urgencyFromDays velocity gate", () => {
  it("a fast seller at zero cover is critical", () => {
    expect(urgencyFromDays(0, 2.0)).toBe("critical");
  });
  it("a slow seller (0.03/day) at zero cover is NOT critical — it's high", () => {
    expect(urgencyFromDays(0, 0.03)).toBe("high");
  });
  it("right at the rate floor (~1 unit / 2 weeks) still counts as critical", () => {
    expect(urgencyFromDays(3, 1 / 14)).toBe("critical");
  });
  it("without a rate, falls back to day-only behavior", () => {
    expect(urgencyFromDays(3)).toBe("critical");
  });
  it("higher day bands are unaffected by rate", () => {
    expect(urgencyFromDays(10, 0.01)).toBe("high");
    expect(urgencyFromDays(20, 0.01)).toBe("medium");
    expect(urgencyFromDays(40, 5)).toBe("low");
  });
});

describe("zForServiceLevel", () => {
  it("defaults per class; unclassified takes C", () => {
    expect(zForServiceLevel("A")).toBe(SERVICE_Z_DEFAULTS.A);
    expect(zForServiceLevel("B")).toBe(SERVICE_Z_DEFAULTS.B);
    expect(zForServiceLevel("C")).toBe(SERVICE_Z_DEFAULTS.C);
    expect(zForServiceLevel(null)).toBe(SERVICE_Z_DEFAULTS.C);
    expect(zForServiceLevel(undefined)).toBe(SERVICE_Z_DEFAULTS.C);
  });

  it("tenant overrides win per class, others keep defaults", () => {
    expect(zForServiceLevel("A", { A: 3.0 })).toBe(3.0);
    expect(zForServiceLevel("B", { A: 3.0 })).toBe(SERVICE_Z_DEFAULTS.B);
    expect(zForServiceLevel(null, { C: 1.0 })).toBe(1.0);
  });

  it("a null override means default, not zero", () => {
    expect(zForServiceLevel("A", { A: null })).toBe(SERVICE_Z_DEFAULTS.A);
  });
});
