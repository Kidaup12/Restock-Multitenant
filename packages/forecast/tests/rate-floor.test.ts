import { describe, it, expect } from "vitest";
import { applyAbcRateFloor, ABC_RATE_FLOORS } from "../src/rate-floor";
import { layeredForecast, type ForecastInput } from "../src/layered";
import type { SalesPoint } from "../src/baseline";

describe("applyAbcRateFloor", () => {
  it("lifts a starved Class-A seller to the A floor", () => {
    expect(applyAbcRateFloor(0.05, "A", true)).toBe(ABC_RATE_FLOORS.A);
  });

  it("lifts a starved Class-B seller to the B floor", () => {
    expect(applyAbcRateFloor(0.01, "B", true)).toBe(ABC_RATE_FLOORS.B);
  });

  it("leaves a rate already above the floor untouched", () => {
    expect(applyAbcRateFloor(1.5, "A", true)).toBe(1.5);
  });

  it("does not floor Class C", () => {
    expect(applyAbcRateFloor(0.02, "C", true)).toBe(0.02);
  });

  it("does not floor an unclassified product", () => {
    expect(applyAbcRateFloor(0.02, null, true)).toBe(0.02);
  });

  it("never resurrects a dead listing (no recent sales)", () => {
    // A product with no recent sales keeps its computed rate even if class A,
    // so layeredForecast's dead-stock guard (zero rate) still fires.
    expect(applyAbcRateFloor(0, "A", false)).toBe(0);
  });
});

describe("layeredForecast applies the ABC floor", () => {
  const today = new Date("2026-08-01T00:00:00Z");

  // A Class-A product that sold recently but has been mostly stocked out, so its
  // censored rate is tiny. History: a handful of recent sale days only.
  function starvedHistory(): SalesPoint[] {
    return [
      { date: new Date("2026-07-28T00:00:00Z"), quantity: 1 },
      { date: new Date("2026-07-30T00:00:00Z"), quantity: 1 },
    ];
  }

  const baseInput = (over: Partial<ForecastInput>): ForecastInput => ({
    productId: "p1",
    productType: null,
    vendor: null,
    sku: "SKU1",
    currentStock: 0,
    abcCategory: "A",
    history: starvedHistory(),
    leadTimeAvg: 7,
    leadTimeStd: 2,
    activePromos: [],
    runDateKey: "2026-08-01",
    ...over,
  });

  it("a recently-selling Class-A item at zero stock is sized off the floored rate", () => {
    // The floor lifts the sizing rate, so a stocked-out A bestseller gets a
    // real reorder quantity instead of being under-ordered to ~nothing. (The
    // displayed finalForecast30d can still be clipped by the best-month cap —
    // the floor's job is the sizing math, which flows through the rate.)
    const floored = layeredForecast(baseInput({}));
    expect(floored.recommendedQty).toBeGreaterThan(0);
    expect(floored.daysUntilStockout).toBe(0); // zero stock, real rate → out now
  });

  it("the floor lifts the reorder quantity vs the same item unclassified", () => {
    const withFloor = layeredForecast(baseInput({ abcCategory: "A" }));
    const noFloor = layeredForecast(baseInput({ abcCategory: "C" }));
    // Same tiny history; A is floored to 0.4/day, C keeps the tiny censored
    // rate — so A must recommend at least as much, and strictly more here.
    expect(withFloor.recommendedQty).toBeGreaterThan(noFloor.recommendedQty);
  });
});
