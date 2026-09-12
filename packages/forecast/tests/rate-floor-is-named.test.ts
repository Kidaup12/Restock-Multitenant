import { describe, expect, it } from "vitest";
import { abcFloorFor, applyAbcRateFloor, ABC_RATE_FLOORS } from "../src/rate-floor";
import { layeredForecast } from "../src/layered";
import type { SalesPoint } from "../src/baseline";

/**
 * When the class floor sets the rate, the buy list has to say so.
 *
 * The client circled the Run/day column: a dozen products at an identical
 * 0.4/day, under a heading that reads as a measured selling speed, each
 * explained by a sentence crediting "the last-N-day rate" — a number the engine
 * had computed and then thrown away. Three things pointing at a measurement
 * that was not one. The floor itself is doing its job; the row was describing
 * it as something else.
 */

const DAY = 86_400_000;
const TODAY = new Date("2026-09-12T00:00:00Z");
const dayAgo = (n: number) => new Date(+TODAY - n * DAY);

/**
 * The shape production actually has: a sparse seller whose shelf is empty now,
 * on a tenant whose snapshots only reach back ten days.
 *
 * That gap is why the floor binds at all. Censoring RAISES a rate — removing
 * empty days shrinks the denominator — so a shelf proven empty for most of a
 * long window ends up with a high rate and no need of a floor. It is only
 * because the proof stops ten days back that the earlier silence counts as
 * in-stock days with no demand, drags the rate down, and lets the floor take
 * over. Judge "mostly empty" on ten days, apply it to sixty.
 */
const SNAPSHOTS_SINCE = dayAgo(10);
function starved(): { history: SalesPoint[]; stockoutDates: Date[] } {
  const history: SalesPoint[] = [
    { date: dayAgo(55), quantity: 1, revenueKes: 100, channel: "shopify" },
    { date: dayAgo(20), quantity: 1, revenueKes: 100, channel: "shopify" },
  ];
  const stockoutDates = Array.from({ length: 9 }, (_, i) => dayAgo(i + 1));
  return { history, stockoutDates };
}

const run = (abc: "A" | "B" | "C" | null) => {
  const { history, stockoutDates } = starved();
  return layeredForecast({
    productId: "p1",
    productType: null,
    vendor: null,
    sku: "SKU-1",
    currentStock: 0,
    abcCategory: abc,
    history,
    leadTimeAvg: 0,
    leadTimeStd: 0,
    activePromos: [],
    stockoutDates,
    snapshotsSince: SNAPSHOTS_SINCE,
    runDateKey: "2026-09-12",
  });
};

describe("abcFloorFor — one source of truth for whether a floor applies", () => {
  it("reports the class floor only when the shelf was proven empty and it still sells", () => {
    expect(abcFloorFor("A", true, true)).toBe(ABC_RATE_FLOORS.A);
    expect(abcFloorFor("B", true, true)).toBe(ABC_RATE_FLOORS.B);
    expect(abcFloorFor("A", true, false)).toBe(0);
    expect(abcFloorFor("A", false, true)).toBe(0);
    expect(abcFloorFor("C", true, true)).toBe(0);
    expect(abcFloorFor(null, true, true)).toBe(0);
  });

  it("cannot drift from the function that applies it", () => {
    // The two answers are derived from one, so a rate below the reported floor
    // is always lifted exactly to it, and one above is never touched.
    for (const abc of ["A", "B", "C", null] as const) {
      for (const rate of [0, 0.05, 0.1, 0.4, 1.5]) {
        const floor = abcFloorFor(abc, true, true);
        const applied = applyAbcRateFloor(rate, abc, true, true);
        expect(applied).toBe(Math.max(rate, floor));
      }
    }
  });
});

describe("the buy list says when a rate is a floor", () => {
  it("names the floor instead of a history window", () => {
    const out = run("A");
    expect(out.reasoning).toContain("A-class minimum of 0.4/day");
    expect(out.reasoning).toContain("floor, not a measured rate");
    // The discarded window must not be credited for the number.
    expect(out.reasoning).not.toMatch(/from the last-\d+-day rate/);
  });

  it("still credits the real window when the floor did not bind", () => {
    // Class C has no floor, so the same starved history keeps its own rate and
    // its own explanation.
    const out = run("C");
    expect(out.reasoning).not.toContain("minimum of");
    expect(out.reasoning).toMatch(/from the (last-\d+-day rate|recency-weighted run rate)/);
  });

  it("names the B floor for a B product", () => {
    const out = run("B");
    expect(out.reasoning).toContain("B-class minimum of 0.1/day");
  });
});
