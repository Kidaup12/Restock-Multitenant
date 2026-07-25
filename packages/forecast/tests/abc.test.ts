import { describe, it, expect } from "vitest";
import { assignAbc, dailySalesValue } from "../src/abc";
import { weightedDailyRate, type SalesPoint } from "../src/baseline";

/**
 * Boundary semantics: for each product in revenue-desc order, cumulative share
 * is computed AFTER adding the product. If cumulative <= 0.7 -> A; <= 0.9 -> B;
 * else C.
 *
 * Consequence: a single product carrying 100% of revenue lands in C (its
 * cumulative share is 1.0 after the first step). Any product whose own
 * contribution alone pushes cumulative past 0.7 cannot be A. These tests lock
 * that exact behavior — downstream consumers read it as-is, so a future change
 * to the boundary semantics must surface here first.
 */

describe("assignAbc", () => {
  it("returns an empty map for empty input", () => {
    expect(assignAbc([])).toEqual({});
  });

  it("handles all-zero revenue without NaN (everyone becomes C)", () => {
    // total = 0 -> cumulative/total guard returns 1 -> everyone falls past 0.9 -> C
    const out = assignAbc([
      { id: "x", revenue: 0 },
      { id: "y", revenue: 0 },
      { id: "z", revenue: 0 },
    ]);
    expect(out.x).toBe("C");
    expect(out.y).toBe("C");
    expect(out.z).toBe("C");
  });

  it("splits a small catalog into A/B/C by cumulative-after-add share", () => {
    // Sorted by revenue desc internally -> processing order: 50, 20, 15, 10, 5
    // cumulative after each step:
    //   50  -> 0.50 <= 0.7 -> A
    //   70  -> 0.70 <= 0.7 -> A
    //   85  -> 0.85 <= 0.9 -> B
    //   95  -> 0.95 >  0.9 -> C
    //   100 -> 1.00 >  0.9 -> C
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
    expect(out.tail1).toBe("C");
    expect(out.tail2).toBe("C");
  });

  it("documents the single-product edge case (lands in C, not A)", () => {
    // cumulative=1.0 after the only product -> C per the boundary semantics.
    const out = assignAbc([{ id: "only", revenue: 500 }]);
    expect(out.only).toBe("C");
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
    // cumulative: 0.35 A, 0.70 A (<= 0.7), 1.0 C
    expect(out.x).toBe("A");
    expect(out.y).toBe("A");
    expect(out.z).toBe("C");
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
