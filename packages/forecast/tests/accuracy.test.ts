import { describe, expect, it } from "vitest";
import {
  naiveMaeScale,
  naiveMseScale,
  pinballLoss,
  scaleFreeAccuracy,
  SEASON_DAYS,
} from "../src/accuracy";

/** Sells nothing most days, 20 units every seventh — the shape of most of a
 *  shop's catalogue below class A. */
function intermittentDaily(days: number): number[] {
  return Array.from({ length: days }, (_, i) => (i % 7 === 6 ? 20 : 0));
}

describe("naive scales", () => {
  it("measures how much the series moves at the given lag", () => {
    // [0,4,0,4] moves 4 units three times at lag 1.
    expect(naiveMaeScale([0, 4, 0, 4], 1)).toBeCloseTo(4, 10);
    expect(naiveMseScale([0, 4, 0, 4], 1)).toBeCloseTo(16, 10);
  });

  it("is null for a series with no movement to normalise against", () => {
    expect(naiveMaeScale([3, 3, 3, 3], 1)).toBeNull();
    // A perfectly weekly series is flat at lag 7 even though it moves daily.
    expect(naiveMaeScale(intermittentDaily(28), SEASON_DAYS)).toBeNull();
    expect(naiveMaeScale(intermittentDaily(28), 1)).not.toBeNull();
  });

  it("is null when the history is too short to difference", () => {
    expect(naiveMaeScale([5], 1)).toBeNull();
    expect(naiveMaeScale([1, 2, 3], SEASON_DAYS)).toBeNull();
  });
});

describe("pinball loss", () => {
  it("prices a shortfall far above an equal excess", () => {
    // Ten wanted. Saying five leaves five unsold sales; saying fifteen leaves
    // five units on the shelf. At a 95% service level those are not equal.
    expect(pinballLoss(10, 5, 0.95)).toBeCloseTo(4.75, 10);
    expect(pinballLoss(10, 15, 0.95)).toBeCloseTo(0.25, 10);
  });

  it("is symmetric at the median", () => {
    expect(pinballLoss(10, 5, 0.5)).toBeCloseTo(pinballLoss(10, 15, 0.5), 10);
  });
});

/**
 * The reason this module exists.
 *
 * A method that gives up and forecasts nothing beats an honest one on mean
 * absolute error, because MAE is minimised by the median and the median of an
 * intermittent product is zero. Anything that picks a champion on MAE — or on
 * any rescaling of it, which is what MASE is — will crown the method that
 * stops trying.
 */
describe("a method that forecasts nothing", () => {
  const daily = intermittentDaily(28);
  // Ten 10-day windows: nine sell nothing, one sells the 20-unit spike.
  const happened = [0, 0, 0, 0, 0, 0, 0, 0, 0, 20];
  const giveUp = happened.map((h) => ({ said: 0, happened: h }));
  const honest = happened.map((h) => ({ said: 2, happened: h }));

  const gaveUp = scaleFreeAccuracy(giveUp, daily, 0.95);
  const tried = scaleFreeAccuracy(honest, daily, 0.95);

  it("wins on mean absolute error", () => {
    const mae = (w: typeof giveUp) =>
      w.reduce((s, x) => s + Math.abs(x.said - x.happened), 0) / w.length;
    expect(mae(giveUp)).toBeCloseTo(2, 10);
    expect(mae(honest)).toBeCloseTo(3.6, 10);
    expect(mae(giveUp)).toBeLessThan(mae(honest));
  });

  it("still wins on MASE, which is why MASE cannot be the selection metric", () => {
    // MASE divides by a constant derived from the history, so it preserves
    // MAE's ordering exactly. Pinned so nobody adopts it as the fix.
    expect(gaveUp.mase!).toBeLessThan(tried.mase!);
  });

  it("loses on RMSSE", () => {
    expect(gaveUp.rmsse!).toBeGreaterThan(tried.rmsse!);
  });

  it("loses on pinball loss", () => {
    // 1.9 against 1.8. Real but slim, because a MEAN forecast of 2/day barely
    // covers a 20-unit spike either — at tau 0.95 both are mostly paying for
    // the shortfall. Pinball separates them properly only when it scores what
    // it is meant to score: a forecast at that quantile, below.
    expect(gaveUp.pinball!).toBeCloseTo(1.9, 10);
    expect(tried.pinball!).toBeCloseTo(1.8, 10);
    expect(gaveUp.pinball!).toBeGreaterThan(tried.pinball!);
  });

  it("loses decisively to a forecast that actually covers the spike", () => {
    // What a 95%-service order-up-to level looks like: enough for the spike.
    const covering = happened.map((h) => ({ said: 20, happened: h }));
    const covered = scaleFreeAccuracy(covering, daily, 0.95);
    // Give-up pays 19 on the one window it misses; covering pays 0.05 × 20 on
    // each of the nine quiet ones and nothing on the spike.
    expect(covered.pinball!).toBeCloseTo(0.9, 10);
    expect(gaveUp.pinball!).toBeGreaterThan(covered.pinball! * 2);
  });
});

describe("scaleFreeAccuracy edges", () => {
  it("returns nulls when nothing was scored", () => {
    expect(scaleFreeAccuracy([], intermittentDaily(28), 0.95)).toEqual({
      mase: null,
      rmsse: null,
      pinball: null,
    });
  });

  it("leaves the scaled metrics null when the history cannot supply a scale", () => {
    const flat = [2, 2, 2, 2, 2, 2, 2, 2];
    const scored = scaleFreeAccuracy([{ said: 3, happened: 2 }], flat, 0.9);
    expect(scored.mase).toBeNull();
    expect(scored.rmsse).toBeNull();
    // Pinball needs no scale, so it still reports.
    expect(scored.pinball).toBeCloseTo(0.1, 10);
  });
});
