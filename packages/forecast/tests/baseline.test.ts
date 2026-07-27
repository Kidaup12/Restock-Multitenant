import { describe, it, expect } from "vitest";
import {
  weightedDailyRate,
  weightedDailyRateAdjusted,
  weightedDailyRateCensored,
  censoredDaysInWindow,
  dampedWindow,
  effectiveWindowDays,
  inferredStockoutGapDays,
  hasStockoutGap,
  daysOfStockRemaining,
  NO_STOCKOUT_DAYS,
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

describe("spike damping", () => {
  /** `days` of steady sales ending yesterday. */
  const steady = (days: number, qty: number) =>
    Array.from({ length: days }, (_, i) => ({ date: day(i + 1), quantity: qty }));

  it("a two-day promo spike barely moves the rate (the whole point)", () => {
    const clean = steady(380, 2);
    const spiked = [...clean];
    spiked[4] = { date: day(5), quantity: 20 }; // 10x, a giveaway nobody logged
    spiked[5] = { date: day(6), quantity: 20 };

    const damped = weightedDailyRateAdjusted(spiked, TODAY);
    expect(damped).toBeLessThan(2 * 1.1); // within 10% of the true 2/day
    // …and it is the damping doing it: the undamped blend runs away.
    expect(weightedDailyRate(spiked, TODAY)).toBeGreaterThan(2 * 1.3);
  });

  it("a slow mover keeps a sensible non-zero rate (a naive daily median would say 0)", () => {
    // 1 unit every third day = 0.333/day, and 2 of every 3 days sell nothing —
    // the median DAILY quantity is 0, which would drop it off the buy list.
    const slow = Array.from({ length: 121 }, (_, i) => ({ date: day(i * 3 + 1), quantity: 1 }));
    const rate = weightedDailyRateAdjusted(slow, TODAY);
    expect(rate).toBeGreaterThan(0.25);
    expect(rate).toBeLessThan(0.4);
  });

  it("a real sustained step change is still tracked, not smothered", () => {
    const history = [...steady(30, 3), ...Array.from({ length: 335 }, (_, i) => ({ date: day(i + 31), quantity: 1 }))];
    const before = weightedDailyRateAdjusted(steady(365, 1), TODAY);
    const after = weightedDailyRateAdjusted(history, TODAY);
    expect(after).toBeGreaterThan(before * 1.8); // the 3x month pulls the blend up hard
  });

  it("nothing is capped below the minimum sale days — three lumpy days keep every unit", () => {
    const lumpy = [
      { date: day(2), quantity: 5 },
      { date: day(9), quantity: 5 },
      { date: day(16), quantity: 40 }, // one bulk buyer, no distribution to judge it against
    ];
    const { units, saleDays } = dampedWindow(lumpy, day(30), TODAY);
    expect(saleDays).toBe(3);
    expect(units).toBe(50);
  });

  it("buckets by DAY, so a two-channel day is one day and not two smaller ones", () => {
    const twoChannels = [
      { date: day(1), quantity: 4, channel: "shopify" },
      { date: day(1), quantity: 6, channel: "pos" },
    ];
    const { units, saleDays } = dampedWindow(twoChannels, day(30), TODAY);
    expect(units).toBe(10);
    expect(saleDays).toBe(1);
  });

  it("ignores future-dated rows — a bad sync date can't leak into the numerator", () => {
    const withFuture = [
      ...steady(60, 2),
      { date: new Date(+TODAY + 5 * 864e5), quantity: 500 },
    ];
    expect(weightedDailyRateAdjusted(withFuture, TODAY)).toBeCloseTo(
      weightedDailyRateAdjusted(steady(60, 2), TODAY),
      10
    );
  });

  it("recency still dominates — last month counts for more than the same month a year ago", () => {
    const lastMonth = steady(30, 4);
    const yearAgo = Array.from({ length: 30 }, (_, i) => ({ date: day(i + 330), quantity: 4 }));
    // Same 120 units, only the position in the year differs.
    expect(weightedDailyRateAdjusted(lastMonth, TODAY)).toBeGreaterThan(
      weightedDailyRateAdjusted(yearAgo, TODAY) * 3
    );
  });

  it("zero history is 0 — never NaN, never Infinity", () => {
    for (const rate of [
      weightedDailyRateAdjusted([], TODAY),
      weightedDailyRateCensored([], [day(1)], TODAY),
    ]) {
      expect(rate).toBe(0);
      expect(Number.isFinite(rate)).toBe(true);
    }
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

describe("in-stock-day denominator (snapshot truth)", () => {
  // Out 10 of the last 30 days, split into two 5-day stretches — the shape a real
  // shop actually has. 2/day on the 20 days it was on the shelf.
  const outDays = [...[7, 8, 9, 10, 11], ...[20, 21, 22, 23, 24]].map(day);
  const outKeys = new Set(outDays.map((d) => d.getTime()));
  const history = [
    { date: day(400), quantity: 1 }, // old anchor: mature product, weighted path
    ...Array.from({ length: 30 }, (_, i) => day(i + 1))
      .filter((d) => !outKeys.has(d.getTime()))
      .map((date) => ({ date, quantity: 2 })),
  ];
  const coveredSince = day(365);

  it("gap inference alone misses it — no run is longer than a week", () => {
    // Two 5-day holes: the >7-day rule subtracts nothing, so the rate divides by
    // 30 and reads 1.33/day for a product that sells 2/day when it's in stock.
    expect(inferredStockoutGapDays(history, day(30), TODAY)).toBe(0);
  });

  it("snapshot days come out of the denominator and the rate reads the truth", () => {
    const inferred = weightedDailyRateAdjusted(history, TODAY);
    const censored = weightedDailyRateCensored(history, outDays, TODAY, undefined, coveredSince);
    // 30d window: 40 units / (30-10) in-stock days = 2/day, versus 40/30 = 1.33.
    expect(censored).toBeGreaterThan(inferred * 1.3);
  });

  it("an empty mask WITH coverage means proven in stock — nothing is inferred away", () => {
    // A dense seller with a 12-day sale gap the snapshots prove was NOT a stockout
    // (demand dipped, the shelf was full). Inference would shrink the denominator
    // and over-state the rate; snapshot truth keeps it honest.
    const gapped = Array.from({ length: 380 }, (_, i) => day(i + 1))
      .filter((d) => {
        const n = Math.round((+TODAY - +d) / 864e5);
        return n < 10 || n > 21;
      })
      .map((date) => ({ date, quantity: 5 }));
    const proven = weightedDailyRateCensored(gapped, [], TODAY, undefined, coveredSince);
    const inferred = weightedDailyRateAdjusted(gapped, TODAY);
    expect(proven).toBeLessThan(inferred);
  });

  it("history older than the snapshots keeps gap inference for the uncovered stretch", () => {
    // Coverage starts 20 days ago; the 90-day window's older 70 days have no
    // proof, so a long gap in there is still inferred rather than read as
    // "in stock the whole time".
    const removed = new Set([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
    const gapped = Array.from({ length: 380 }, (_, i) => day(i + 1))
      .filter((d) => !removed.has(Math.round((+TODAY - +d) / 864e5)))
      .map((date) => ({ date, quantity: 5 }));
    const partial = weightedDailyRateCensored(gapped, [], TODAY, undefined, day(20));
    const full = weightedDailyRateCensored(gapped, [], TODAY, undefined, day(365));
    expect(partial).toBeGreaterThan(full); // uncovered gap still leaves the denominator
  });

  it("no coverage date and no mask is exactly the gap-inference variant", () => {
    expect(weightedDailyRateCensored(history, [], TODAY)).toBe(
      weightedDailyRateAdjusted(history, TODAY)
    );
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
  it("daysOfStockRemaining: no rate → the sentinel (never divide by ~0)", () => {
    expect(daysOfStockRemaining(50, 0)).toBe(NO_STOCKOUT_DAYS);
    expect(daysOfStockRemaining(50, 0.00005)).toBe(NO_STOCKOUT_DAYS);
    expect(daysOfStockRemaining(50, 2)).toBe(25);
  });

  it("NO_STOCKOUT_DAYS names the sentinel so consumers never test a bare 999", () => {
    expect(NO_STOCKOUT_DAYS).toBe(999);
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
