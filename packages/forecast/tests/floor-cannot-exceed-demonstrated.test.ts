import { describe, expect, it } from "vitest";
import { applyAbcRateFloor, demonstratedDailyRate, ABC_RATE_FLOORS } from "../src/rate-floor";
import { layeredForecast } from "../src/layered";
import type { SalesPoint } from "../src/baseline";

/**
 * The floor rescues a starved bestseller. It must not invent one.
 *
 * It was a flat constant that never asked whether the product had ever been
 * fast, so on the client's catalogue a line that sold four units in ninety days
 * was served at 0.4/day — twelve a month. Measured on production: seven
 * products lifted above anything their history supports, the worst by 2.4x,
 * about 34 units of over-ordering per cycle.
 *
 * The ceiling is the product's own demonstrated speed: units over the span from
 * its first sale to its last. The span ends at the last sale, so the silence
 * after a stockout cannot drag it down and a genuine bestseller keeps its
 * rescue.
 */

const DAY = 86_400_000;
const TODAY = new Date("2026-09-12T00:00:00Z");
const dayAgo = (n: number) => new Date(+TODAY - n * DAY);
const sale = (n: number, q: number): SalesPoint => ({
  date: dayAgo(n),
  quantity: q,
  revenueKes: q * 100,
  channel: "shopify",
});

describe("demonstratedDailyRate", () => {
  it("measures units over the span from first sale to last", () => {
    // 3 units across 18 days = 0.167/day — the production shape.
    expect(demonstratedDailyRate([sale(23, 1), sale(14, 1), sale(5, 1)])).toBeCloseTo(3 / 18, 5);
  });

  it("stops at the last sale, so a stockout since does not drag it down", () => {
    // Same two sales, judged 5 days later. A span that ran to today would read
    // lower every day the shelf stayed empty — and would strip a starved
    // bestseller of the rescue this floor exists to give it.
    const early = demonstratedDailyRate([sale(30, 10), sale(20, 10)]);
    const late = demonstratedDailyRate([sale(35, 10), sale(25, 10)]);
    expect(early).toBe(late);
  });

  it("is null when nothing has ever sold", () => {
    expect(demonstratedDailyRate([])).toBeNull();
    expect(demonstratedDailyRate([sale(5, 0)])).toBeNull();
  });
});

describe("the floor cannot lift a product past what it has shown", () => {
  it("stops at the demonstrated rate for a slow seller", () => {
    // The defect: computed 0.04, class floor 0.4, but this line has never sold
    // faster than 0.167/day.
    expect(applyAbcRateFloor(0.04, "A", true, true, 3 / 18)).toBeCloseTo(3 / 18, 5);
  });

  it("still rescues a genuine bestseller all the way to the floor", () => {
    // Sold fast, then ran out. Its demonstrated rate is well above the floor,
    // so the floor applies in full — the case it was written for.
    expect(applyAbcRateFloor(0.05, "A", true, true, 2.5)).toBe(ABC_RATE_FLOORS.A);
  });

  it("never pulls a rate below what was computed", () => {
    // A ceiling is not a cap on the measurement. If the product is currently
    // measured faster than its lifetime average, that measurement stands.
    expect(applyAbcRateFloor(0.9, "A", true, true, 0.1)).toBe(0.9);
    expect(applyAbcRateFloor(0.3, "A", true, true, 0.1)).toBe(0.3);
  });

  it("applies the floor in full when there is nothing to measure against", () => {
    // Unreachable in the engine — no sales means no recent sales means no floor
    // — but the behaviour is pinned so a future caller cannot be surprised.
    expect(applyAbcRateFloor(0.05, "A", true, true, null)).toBe(ABC_RATE_FLOORS.A);
  });

  it("leaves class C alone, ceiling or not", () => {
    expect(applyAbcRateFloor(0.02, "C", true, true, 0.001)).toBe(0.02);
  });
});

describe("the buy list says which of the two set the number", () => {
  const run = (history: SalesPoint[]) =>
    layeredForecast({
      productId: "p1",
      productType: null,
      vendor: null,
      sku: "SKU-1",
      currentStock: 0,
      abcCategory: "A",
      history,
      leadTimeAvg: 0,
      leadTimeStd: 0,
      activePromos: [],
      stockoutDates: Array.from({ length: 9 }, (_, i) => dayAgo(i + 1)),
      snapshotsSince: dayAgo(10),
      runDateKey: "2026-09-12",
    });

  it("names the product's own best when the ceiling bound", () => {
    const out = run([sale(55, 1), sale(20, 1)]);
    expect(out.reasoning).toContain("the fastest this has sold while it was in stock");
    expect(out.reasoning).not.toContain("class minimum");
  });

  it("names the class minimum when the floor applied in full", () => {
    // Sold 40 units across 10 days before running out: 4/day demonstrated, far
    // above the 0.4 floor, so the floor is what caps the lift.
    const out = run([sale(55, 20), sale(45, 20), sale(20, 1)]);
    expect(out.reasoning).toContain("A-class minimum of 0.4/day");
  });
});
