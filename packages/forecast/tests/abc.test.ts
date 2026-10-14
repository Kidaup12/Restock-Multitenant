import { describe, it, expect } from "vitest";
import {
  assignAbc,
  dailySalesValue,
  trailingRevenue,
  MIN_RUN_RATE_FOR_A,
  MIN_RUN_RATE_FOR_B,
} from "../src/abc";
import { weightedDailyRate, type SalesPoint } from "../src/baseline";

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

describe("assignAbc velocity floor", () => {
  it("demotes a high-revenue but slow item out of A", () => {
    // hero earns the most but sells < 0.4/day → floored to B.
    const out = assignAbc([
      { id: "hero", revenue: 1000, runRate: 0.1 },
      { id: "mover", revenue: 400, runRate: 5 },
      { id: "tail", revenue: 50, runRate: 2 },
    ]);
    expect(out.hero).toBe("B"); // value said A, velocity floor said no
    expect(out.mover).toBe("A"); // value put it below hero; with hero demoted the cut still lands it A
  });

  it("demotes a barely-selling item all the way to C", () => {
    const out = assignAbc([
      { id: "hero", revenue: 1000, runRate: 0.05 }, // below B floor too
      { id: "b", revenue: 400, runRate: 5 },
    ]);
    expect(out.hero).toBe("C");
  });

  it("leaves a genuine fast mover in A", () => {
    const out = assignAbc([
      { id: "hero", revenue: 1000, runRate: 8 },
      { id: "b", revenue: 50, runRate: 1 },
    ]);
    expect(out.hero).toBe("A");
  });

  it("without runRate, no floor is applied (back-compat)", () => {
    const out = assignAbc([{ id: "hero", revenue: 1000 }, { id: "b", revenue: 50 }]);
    expect(out.hero).toBe("A");
  });

  it("floor thresholds are the documented values", () => {
    expect(MIN_RUN_RATE_FOR_A).toBe(0.4);
    expect(MIN_RUN_RATE_FOR_B).toBe(0.1);
  });
});

describe("trailingRevenue", () => {
  const TODAY = new Date("2026-07-21T00:00:00Z");
  const day = (daysAgo: number) => new Date(+TODAY - daysAgo * 864e5);

  it("sums revenueKes inside the window and ignores older sales", () => {
    const history: SalesPoint[] = [
      { date: day(10), quantity: 2, revenueKes: 200 }, // in 90d window
      { date: day(80), quantity: 1, revenueKes: 100 }, // in window
      { date: day(120), quantity: 5, revenueKes: 999 }, // OUTSIDE 90d window
    ];
    expect(trailingRevenue(history, TODAY, 90)).toBe(300);
  });

  it("respects a custom window", () => {
    const history: SalesPoint[] = [
      { date: day(5), quantity: 1, revenueKes: 100 },
      { date: day(40), quantity: 1, revenueKes: 100 },
    ];
    expect(trailingRevenue(history, TODAY, 30)).toBe(100); // 40d-ago sale excluded
  });

  it("is zero with no sales", () => {
    expect(trailingRevenue([], TODAY)).toBe(0);
  });
});

describe("dailySalesValue", () => {
  const TODAY = new Date("2026-07-21T00:00:00Z");
  const day = (daysAgo: number) => new Date(+TODAY - daysAgo * 864e5);

  it("weights a pricey earner above a cheap fast-mover", () => {
    const fastCheap = Array.from({ length: 30 }, (_, i) => ({ date: day(i + 1), quantity: 4 }));
    const slowPricey = Array.from({ length: 30 }, (_, i) => ({ date: day(i + 1), quantity: 1 }));
    expect(dailySalesValue(slowPricey, 4000, TODAY)).toBeGreaterThan(dailySalesValue(fastCheap, 200, TODAY));
  });

  it("a product with no sales has zero value", () => {
    expect(dailySalesValue([], 5000, TODAY)).toBe(0);
  });

  it("ranks a strong seller on its in-stock rate, not its stockout-diluted rate", () => {
    // Sells 2/day for a stretch, then a long out-of-stock gap, then sells again.
    // The gap days come out of the denominator, so the ABC value reflects demand
    // while in stock — otherwise a chronic-stockout earner is under-ranked.
    const gappy: SalesPoint[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ date: day(30 - i), quantity: 2 })),
      ...Array.from({ length: 10 }, (_, i) => ({ date: day(10 - i), quantity: 2 })),
    ];
    expect(dailySalesValue(gappy, 1000, TODAY)).toBeGreaterThan(
      weightedDailyRate(gappy, TODAY) * 1000
    );
  });
});
