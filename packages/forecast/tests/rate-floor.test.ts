import { describe, it, expect } from "vitest";
import { applyAbcRateFloor, shelfWasMostlyEmpty, ABC_RATE_FLOORS } from "../src/rate-floor";
import { layeredForecast, type ForecastInput } from "../src/layered";
import type { SalesPoint } from "../src/baseline";

const TODAY = new Date("2026-08-01T00:00:00Z");
const WINDOW_START = new Date("2026-07-02T00:00:00Z"); // today - 30
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** `n` consecutive empty-shelf days ending the day before `TODAY`. */
function emptyDays(n: number): Date[] {
  return Array.from({ length: n }, (_, i) => new Date(+TODAY - (i + 1) * 86_400_000));
}

/** A genuine bestseller's demonstrated speed — above either floor, so the cases
 *  below keep testing the floor rather than the ceiling on it. */
const FAST = 2;

describe("applyAbcRateFloor", () => {
  it("lifts a starved Class-A seller to the A floor", () => {
    expect(applyAbcRateFloor(0.05, "A", true, true, FAST)).toBe(ABC_RATE_FLOORS.A);
  });

  it("lifts a starved Class-B seller to the B floor", () => {
    expect(applyAbcRateFloor(0.01, "B", true, true, FAST)).toBe(ABC_RATE_FLOORS.B);
  });

  it("leaves a rate already above the floor untouched", () => {
    expect(applyAbcRateFloor(1.5, "A", true, true, FAST)).toBe(1.5);
  });

  it("does not floor Class C", () => {
    expect(applyAbcRateFloor(0.02, "C", true, true, FAST)).toBe(0.02);
  });

  it("does not floor an unclassified product", () => {
    expect(applyAbcRateFloor(0.02, null, true, true, FAST)).toBe(0.02);
  });

  it("never resurrects a dead listing (no recent sales)", () => {
    // A product with no recent sales keeps its computed rate even if class A,
    // so layeredForecast's dead-stock guard (zero rate) still fires.
    expect(applyAbcRateFloor(0, "A", false, true, null)).toBe(0);
  });

  it("leaves a product alone when its shelf was NOT mostly empty", () => {
    // The reported defect: a fully-stocked line selling 0.09/day was served at
    // 0.4 — four times its real demand, ordered over a lead time. A low rate
    // measured on a full shelf is demand, not an outage.
    expect(applyAbcRateFloor(0.09, "A", true, false, FAST)).toBe(0.09);
  });
});

describe("shelfWasMostlyEmpty", () => {
  it("is false without snapshots — absence of evidence is not a full shelf, nor an empty one", () => {
    expect(shelfWasMostlyEmpty(emptyDays(30), undefined, WINDOW_START, TODAY)).toBe(false);
    expect(shelfWasMostlyEmpty(undefined, undefined, WINDOW_START, TODAY)).toBe(false);
  });

  it("is false for a shelf that was stocked throughout", () => {
    expect(shelfWasMostlyEmpty([], WINDOW_START, WINDOW_START, TODAY)).toBe(false);
  });

  it("is true once the shelf was empty for most of the proven days", () => {
    expect(shelfWasMostlyEmpty(emptyDays(16), WINDOW_START, WINDOW_START, TODAY)).toBe(true);
  });

  it("needs a strict majority — exactly half is not most", () => {
    expect(shelfWasMostlyEmpty(emptyDays(15), WINDOW_START, WINDOW_START, TODAY)).toBe(false);
  });

  it("judges only the days snapshots actually cover", () => {
    // Snapshotting began four days ago. Three of those four were empty, so on
    // the evidence that exists the shelf was mostly empty — the 26 days before
    // it are not credited as stocked, and not counted against it either.
    const since = new Date(+TODAY - 4 * 86_400_000);
    expect(shelfWasMostlyEmpty(emptyDays(3), since, WINDOW_START, TODAY)).toBe(true);
    // One empty day of four is not most.
    expect(shelfWasMostlyEmpty(emptyDays(1), since, WINDOW_START, TODAY)).toBe(false);
  });

  it("ignores empty days outside the window being judged", () => {
    const old = [day("2026-05-01"), day("2026-05-02"), day("2026-05-03")];
    expect(shelfWasMostlyEmpty(old, day("2026-01-01"), WINDOW_START, TODAY)).toBe(false);
  });

  it("counts a day once however many snapshot rows it has", () => {
    const dupes = [...emptyDays(16), ...emptyDays(16)];
    expect(shelfWasMostlyEmpty(dupes, WINDOW_START, WINDOW_START, TODAY)).toBe(true);
    const halfDupes = [...emptyDays(15), ...emptyDays(15)];
    expect(shelfWasMostlyEmpty(halfDupes, WINDOW_START, WINDOW_START, TODAY)).toBe(false);
  });
});

describe("layeredForecast applies the ABC floor", () => {
  /** A Class-A product that sold recently but has been mostly stocked out. */
  function starvedHistory(): SalesPoint[] {
    return [
      { date: day("2026-07-28"), quantity: 1 },
      { date: day("2026-07-30"), quantity: 1 },
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
    // The shelf really was empty, and the snapshots say so — without this proof
    // the floor no longer speaks, which is the whole point of the change.
    stockoutDates: emptyDays(25),
    snapshotsSince: WINDOW_START,
    ...over,
  });

  it("a recently-selling Class-A item at zero stock is sized off the floored rate", () => {
    const floored = layeredForecast(baseInput({}));
    expect(floored.recommendedQty).toBeGreaterThan(0);
    expect(floored.daysUntilStockout).toBe(0); // zero stock, real rate → out now
  });

  it("the floor lifts the reorder quantity vs the same item unclassified", () => {
    const withFloor = layeredForecast(baseInput({ abcCategory: "A" }));
    const noFloor = layeredForecast(baseInput({ abcCategory: "C" }));
    expect(withFloor.recommendedQty).toBeGreaterThan(noFloor.recommendedQty);
  });

  it("does not lift a Class-A product whose shelf was full the whole time", () => {
    // The shop's report, end to end: a steady slow seller, in stock throughout,
    // must be forecast at what it sells rather than at the class guarantee.
    const steady: SalesPoint[] = Array.from({ length: 33 }, (_, i) => ({
      date: new Date(+TODAY - (i + 1) * 11 * 86_400_000),
      quantity: 1,
    }));
    const stocked = layeredForecast(
      baseInput({ history: steady, currentStock: 20, stockoutDates: [] })
    );
    expect(stocked.layer1Forecast30d / 30).toBeLessThan(ABC_RATE_FLOORS.A);
  });
});
