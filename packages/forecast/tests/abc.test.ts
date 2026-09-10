import { describe, it, expect } from "vitest";
import {
  assignAbc,
  trailingRevenue,
  resolveAbcWindowDays,
  DEFAULT_ABC_WINDOW_DAYS,
  MIN_RUN_RATE_FOR_A,
  MIN_RUN_RATE_FOR_B,
} from "../src/abc";
import type { SalesPoint } from "../src/baseline";

/**
 * Boundary semantics: for each product in revenue-desc order, the cut is made
 * on the share of value ranked ABOVE it, excluding itself. Above < 0.7 -> A;
 * < 0.9 -> B; else C.
 *
 * The share above the first product is always 0, so the best seller is always
 * A. Counting the product itself first meant a shop whose top SKU carried most
 * of its value classified that SKU as C, and C is sized by the tail's min/max
 * rule rather than the forecast — the shop's best earner ordered like a
 * slow-mover. These tests lock the boundary; downstream consumers read the
 * classes as-is, so a future change must surface here first.
 */

describe("assignAbc", () => {
  it("returns an empty map for empty input", () => {
    expect(assignAbc([])).toEqual({});
  });

  it("handles all-zero revenue without NaN (everyone becomes C)", () => {
    // total = 0 -> the share-above guard returns 1 -> everyone falls past 0.9 -> C
    const out = assignAbc([
      { id: "x", revenue: 0 },
      { id: "y", revenue: 0 },
      { id: "z", revenue: 0 },
    ]);
    expect(out.x).toBe("C");
    expect(out.y).toBe("C");
    expect(out.z).toBe("C");
  });

  it("splits a small catalog into A/B/C by the share ranked above each product", () => {
    // Sorted by revenue desc internally -> processing order: 50, 20, 15, 10, 5
    // share above each step:
    //   50  -> 0.00 < 0.7 -> A
    //   20  -> 0.50 < 0.7 -> A
    //   15  -> 0.70         -> B
    //   10  -> 0.85 < 0.9 -> B
    //    5  -> 0.95         -> C
    const out = assignAbc([
      { id: "top1", revenue: 50 },
      { id: "mid1", revenue: 15 },
      { id: "top2", revenue: 20 },
      { id: "tail1", revenue: 10 },
      { id: "tail2", revenue: 5 },
    ]);
    expect(out.top1).toBe("A");
    expect(out.top2).toBe("A");
    expect(out.mid1).toBe("B");
    expect(out.tail1).toBe("B");
    expect(out.tail2).toBe("C");
  });

  it("puts the only product in a one-product catalogue in A", () => {
    // Nothing ranks above it, so its share-above is 0. The shop's entire
    // business cannot be tail stock.
    const out = assignAbc([{ id: "only", revenue: 500 }]);
    expect(out.only).toBe("A");
  });

  it("keeps a dominant best seller in A instead of filing it under the tail", () => {
    // The case that motivated the change: one SKU is 95% of catalogue value.
    const out = assignAbc([
      { id: "hero", revenue: 950 },
      { id: "small1", revenue: 30 },
      { id: "small2", revenue: 20 },
    ]);
    expect(out.hero).toBe("A");
    expect(out.small1).toBe("C");
    expect(out.small2).toBe("C");
  });

  it("is order-independent (sorts internally by revenue desc)", () => {
    const ordered = assignAbc([
      { id: "a", revenue: 50 },
      { id: "b", revenue: 15 },
      { id: "c", revenue: 20 },
      { id: "d", revenue: 10 },
      { id: "e", revenue: 5 },
    ]);
    const shuffled = assignAbc([
      { id: "e", revenue: 5 },
      { id: "c", revenue: 20 },
      { id: "a", revenue: 50 },
      { id: "d", revenue: 10 },
      { id: "b", revenue: 15 },
    ]);
    expect(ordered).toEqual(shuffled);
  });

  it("equal-revenue products land in the same class when cumulative allows", () => {
    const out = assignAbc([
      { id: "x", revenue: 35 },
      { id: "y", revenue: 35 },
      { id: "z", revenue: 30 },
    ]);
    // share above: 0.00 A, 0.35 A, 0.70 B
    expect(out.x).toBe("A");
    expect(out.y).toBe("A");
    expect(out.z).toBe("B");
  });
});

/**
 * The velocity floor. Ranking by value alone lets a rarely-sold premium item
 * carry a big number on a handful of sales, so a product that does not actually
 * move cannot be A however much it earned. The floors are the same two numbers
 * rate-floor.ts guarantees a class-A product, which is the point: one file
 * decides who qualifies, the other what qualifying is worth.
 */
describe("assignAbc — velocity floor", () => {
  it("demotes a value-A product below the A floor to B", () => {
    // 'slow' tops the value cut (share above = 0 -> A) but sells 0.1/day, under
    // the A floor. It drops one tier, not to the tail: it still earns.
    const out = assignAbc([
      { id: "slow", revenue: 60, runRate: 0.1 },
      { id: "fast", revenue: 50, runRate: 2 },
      { id: "mid", revenue: 40, runRate: 1 },
    ]);
    expect(out.slow).toBe("B");
    expect(out.fast).toBe("A");
  });

  it("demotes all the way to C when it is under the B floor too", () => {
    const out = assignAbc([
      { id: "slow", revenue: 60, runRate: 0.05 },
      { id: "fast", revenue: 50, runRate: 2 },
      { id: "mid", revenue: 40, runRate: 1 },
    ]);
    expect(out.slow).toBe("C");
  });

  it("keeps a product that sells exactly at a floor in its class", () => {
    // The floors are minimums to clear, not thresholds to beat.
    const out = assignAbc([
      { id: "atA", revenue: 60, runRate: MIN_RUN_RATE_FOR_A },
      { id: "other", revenue: 40, runRate: 3 },
    ]);
    expect(out.atA).toBe("A");

    const tail = assignAbc([
      { id: "hero", revenue: 950, runRate: 5 },
      { id: "atB", revenue: 30, runRate: MIN_RUN_RATE_FOR_B },
      { id: "small", revenue: 20, runRate: 1 },
    ]);
    // 'atB' falls in the C value-band here, so the B floor is what it is tested
    // against only once it has been demoted into B — a floor never promotes.
    expect(tail.atB).toBe("C");
  });

  it("leaves the classification untouched when no run rate is supplied", () => {
    const withRate = assignAbc([
      { id: "a", revenue: 100, runRate: 5 },
      { id: "b", revenue: 20, runRate: 4 },
    ]);
    const without = assignAbc([
      { id: "a", revenue: 100 },
      { id: "b", revenue: 20 },
    ]);
    expect(without).toEqual(withRate);
  });

  it("the two cases the shop reported: 0.10/day is B, 0.09/day is C", () => {
    // Both earn enough to top the value cut; neither sells enough to be a
    // bestseller. 0.10 clears the B floor, 0.09 does not.
    const out = assignAbc([
      { id: "tenth", revenue: 100, runRate: 0.1 },
      { id: "ninth", revenue: 100, runRate: 0.09 },
      { id: "other", revenue: 10, runRate: 1 },
    ]);
    expect(out.tenth).toBe("B");
    expect(out.ninth).toBe("C");
  });

  it("a line that used to sell and has stopped is demoted by the floor, not hidden by the ranking", () => {
    // Ranking on real receipts keeps a big earlier earner high in the value cut.
    // The floor is what takes it out of A — which is why both changes ship
    // together: revenue says what it earned, run rate says whether it still does.
    const out = assignAbc([
      { id: "wasHot", revenue: 500, runRate: 0.02 },
      { id: "steady", revenue: 300, runRate: 3 },
    ]);
    expect(out.wasHot).toBe("C");
    expect(out.steady).toBe("A");
  });
});

describe("trailingRevenue", () => {
  const TODAY = new Date("2026-07-21T00:00:00Z");
  const day = (daysAgo: number) => new Date(+TODAY - daysAgo * 864e5);

  it("sums the money on the receipts inside the window", () => {
    const history: SalesPoint[] = [
      { date: day(1), quantity: 2, revenueKes: 500 },
      { date: day(10), quantity: 1, revenueKes: 250 },
    ];
    expect(trailingRevenue(history, 999, 90, TODAY)).toBe(750);
  });

  it("ignores sales older than the window", () => {
    const history: SalesPoint[] = [
      { date: day(10), quantity: 1, revenueKes: 100 },
      { date: day(100), quantity: 50, revenueKes: 99_000 },
    ];
    expect(trailingRevenue(history, 999, 90, TODAY)).toBe(100);
  });

  it("ranks a discounted line on what it took, not on its price tag", () => {
    // Always sold at half price: the shelf price says 1000 a unit, the till says
    // 500. Ranking on the price tag would put it twice as high as it earned.
    const history: SalesPoint[] = Array.from({ length: 10 }, (_, i) => ({
      date: day(i + 1),
      quantity: 1,
      revenueKes: 500,
    }));
    expect(trailingRevenue(history, 1000, 90, TODAY)).toBe(5000);
  });

  it("falls back to the catalogue price for a row with units and no money", () => {
    // A till line with no price signal, or a Shopify line with no unit price.
    // Without the fallback a POS-fed shop ranks its real sellers at zero and the
    // whole catalogue files under C.
    const history: SalesPoint[] = [
      { date: day(2), quantity: 3, revenueKes: 0 },
      { date: day(3), quantity: 1, revenueKes: 400 },
    ];
    expect(trailingRevenue(history, 200, 90, TODAY)).toBe(1000);
  });

  it("keeps a refund negative rather than treating it as a missing price", () => {
    const history: SalesPoint[] = [
      { date: day(1), quantity: 2, revenueKes: 500 },
      { date: day(2), quantity: -1, revenueKes: -250 },
    ];
    expect(trailingRevenue(history, 999, 90, TODAY)).toBe(250);
  });

  it("a product with no sales earns nothing", () => {
    expect(trailingRevenue([], 5000, 90, TODAY)).toBe(0);
  });
});

describe("resolveAbcWindowDays", () => {
  it("takes an offered choice as given", () => {
    expect(resolveAbcWindowDays(30)).toBe(30);
    expect(resolveAbcWindowDays(60)).toBe(60);
    expect(resolveAbcWindowDays(90)).toBe(90);
  });

  it("falls back to the default for an unset column or a value nobody offered", () => {
    expect(resolveAbcWindowDays(null)).toBe(DEFAULT_ABC_WINDOW_DAYS);
    expect(resolveAbcWindowDays(undefined)).toBe(DEFAULT_ABC_WINDOW_DAYS);
    expect(resolveAbcWindowDays(0)).toBe(DEFAULT_ABC_WINDOW_DAYS);
    expect(resolveAbcWindowDays(-45)).toBe(DEFAULT_ABC_WINDOW_DAYS);
    expect(resolveAbcWindowDays(100_000)).toBe(DEFAULT_ABC_WINDOW_DAYS);
  });
});
