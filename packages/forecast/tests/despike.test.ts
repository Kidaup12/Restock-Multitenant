import { describe, it, expect } from "vitest";
import {
  weightedDailyRateAdjusted,
  weightedDailyRateCensored,
  runRateDaily,
  type SalesPoint,
} from "../src/index";

const asOf = new Date("2026-06-01T00:00:00Z");

/** UTC day-key `n` days before `asOf`. */
function back(n: number): Date {
  const d = new Date(asOf);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** `days` of steady daily sales ending yesterday: one point per day at `qty`. */
function steady(days: number, qty: number): SalesPoint[] {
  const h: SalesPoint[] = [];
  for (let i = 1; i <= days; i++) h.push({ date: back(i), quantity: qty });
  return h;
}

describe("promo-spike de-spike (excludedDates)", () => {
  // 380 days of a steady 3/day so all three rate windows are full, with one
  // recent day blown out to 300 by a promo.
  const history = steady(380, 3);
  history[4]!.quantity = 300; // the point at back(5)
  const spikeDay = back(5);

  it("an UNLOGGED spike is absorbed by the damping, not carried into the rate", () => {
    // Before spike damping this read >9/day off a 3/day product — one 300-unit
    // day tripling the baseline until someone remembered to log the promo.
    const included = weightedDailyRateAdjusted(history, asOf);
    expect(included).toBeLessThan(3.2);
    expect(included).toBeGreaterThan(3); // the day still counts, capped — never erased
  });

  it("censoring the spike day drops the rate back to the true baseline", () => {
    const steadyRate = weightedDailyRateAdjusted(steady(380, 3), asOf); // 3/day, no spike
    const included = weightedDailyRateAdjusted(history, asOf);
    const excluded = weightedDailyRateAdjusted(history, asOf, [spikeDay]);
    expect(excluded).toBeLessThan(included);
    expect(excluded).toBeCloseTo(steadyRate, 6); // spike removed from numerator AND denominator
    expect(excluded).toBeCloseTo(3, 6);
  });
});

describe("closure-day de-deflation (excludedDates)", () => {
  // Short history -> the new-product single-window path (rateOverWindow).
  const normal = steady(20, 5); // 20 days, sells 5/day every day
  const closureDay = back(10);
  const withClosure = normal.filter((p) => p.date.getTime() !== closureDay.getTime());

  it("an un-censored closed day deflates the rate below the normal level", () => {
    const normalRate = runRateDaily(normal, asOf);
    const deflated = runRateDaily(withClosure, asOf);
    expect(normalRate).toBeCloseTo(5, 10);
    expect(deflated).toBeLessThan(normalRate);
    expect(deflated).toBeCloseTo(4.75, 10);
  });

  it("censoring the closed day restores the true normal-day rate", () => {
    const normalRate = runRateDaily(normal, asOf);
    const deflated = runRateDaily(withClosure, asOf);
    const corrected = runRateDaily(withClosure, asOf, undefined, [closureDay]);
    expect(corrected).toBeGreaterThan(deflated);
    expect(corrected).toBeCloseTo(normalRate, 10);
    expect(corrected).toBeCloseTo(5, 10);
  });
});

describe("stockout-gap × closure overlap is de-duplicated", () => {
  // Dense 380-day history with a 12-day stockout gap (back 10..20 removed, so the
  // points at back 9 and 21 sit 12 days apart -> 11 inferred gap days) and one
  // isolated closed day outside any gap (back 30 removed, neighbours 1 day off).
  const removed = new Set<number>([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 30]);
  const history = steady(380, 5).filter((p) => {
    const n = Math.round((asOf.getTime() - p.date.getTime()) / 86_400_000);
    return !removed.has(n);
  });
  const closureInGap = back(15); // sits inside the inferred 12-day gap
  const closureOutGap = back(30); // isolated no-sale day, not inside any gap

  it("a closure inside an inferred gap is counted once (rate unchanged)", () => {
    const baseline = weightedDailyRateAdjusted(history, asOf);
    const excludeInGap = weightedDailyRateAdjusted(history, asOf, [closureInGap]);
    // The gap already removed this day from the denominator; routing it through
    // excludedDates must not subtract it a second time -> identical rate.
    expect(excludeInGap).toBeCloseTo(baseline, 10);
  });

  it("a closure outside any gap does shrink the denominator (rate rises)", () => {
    const baseline = weightedDailyRateAdjusted(history, asOf);
    const excludeOutGap = weightedDailyRateAdjusted(history, asOf, [closureOutGap]);
    expect(excludeOutGap).toBeGreaterThan(baseline);
  });
});

describe("empty excludedDates is identical to the current functions", () => {
  const history = steady(380, 4);
  history[2]!.quantity = 80; // a spike, so the numbers aren't trivially flat
  const stockouts = [back(3), back(4), back(9)];
  const shortHistory = steady(20, 5);

  it("weightedDailyRateAdjusted: [] and undefined match the two-arg call", () => {
    const baseline = weightedDailyRateAdjusted(history, asOf);
    expect(weightedDailyRateAdjusted(history, asOf, [])).toBe(baseline);
    expect(weightedDailyRateAdjusted(history, asOf, undefined)).toBe(baseline);
  });

  it("weightedDailyRateCensored: [] matches the three-arg call (with and without a mask)", () => {
    const withMask = weightedDailyRateCensored(history, stockouts, asOf);
    expect(weightedDailyRateCensored(history, stockouts, asOf, [])).toBe(withMask);
    const noMask = weightedDailyRateCensored(history, [], asOf);
    expect(weightedDailyRateCensored(history, [], asOf, [])).toBe(noMask);
  });

  it("runRateDaily: absent excludedDates matches the prior signature (both paths)", () => {
    // New-product path
    expect(runRateDaily(shortHistory, asOf, undefined, [])).toBe(runRateDaily(shortHistory, asOf));
    // Weighted path, with a stockout mask
    expect(runRateDaily(history, asOf, stockouts, undefined)).toBe(runRateDaily(history, asOf, stockouts));
    expect(runRateDaily(history, asOf, stockouts, [])).toBe(runRateDaily(history, asOf, stockouts));
  });
});
