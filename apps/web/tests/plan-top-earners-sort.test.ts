import { describe, expect, it } from "vitest";
import { earnerScore } from "../app/(shell)/plan/buy-checklist";

/**
 * "Top earners" on the buy list.
 *
 * The point of this sort is that it disagrees with the two that already exist.
 * "Fastest-selling" ranks a busy product the shop barely makes anything on;
 * "Highest 30d revenue" ranks turnover, which is the same mistake wearing a
 * bigger number. If this ordering ever matches either of those on the fixtures
 * below, it has been reimplemented as one of them.
 */

const busyThinMargin = { runRatePerDay: 100, priceKes: 105, unitCostKes: 100 };
const slowFatMargin = { runRatePerDay: 5, priceKes: 900, unitCostKes: 300 };

describe("the top-earners score", () => {
  it("ranks earnings above turnover", () => {
    // Sells 20x faster, and earns a fraction as much: 100x5=500 vs 5x600=3000.
    expect(earnerScore(busyThinMargin)).toBeLessThan(earnerScore(slowFatMargin));
  });

  it("disagrees with a velocity ranking", () => {
    // The control this exists for: sorting on runRatePerDay would invert it.
    const byVelocity = busyThinMargin.runRatePerDay > slowFatMargin.runRatePerDay;
    const byEarnings = earnerScore(busyThinMargin) > earnerScore(slowFatMargin);
    expect(byEarnings, "top earners is ranking by speed, not by money").not.toBe(byVelocity);
  });

  it("sinks a line whose cost is withheld rather than scoring it as free margin", () => {
    // A money-blind read nulls the cost. Treating null as 0 would price the
    // whole selling price as profit and float the row to the top.
    const hidden = { runRatePerDay: 50, priceKes: 900, unitCostKes: null };
    expect(earnerScore(hidden)).toBeLessThan(earnerScore(busyThinMargin));
    expect(earnerScore(hidden)).toBeLessThan(0);
  });
});
