import { describe, expect, it } from "vitest";
import { destinationShares, sizeTransfers } from "../lib/data/transfers";

/**
 * The transfer sizing engine, driven directly (it is pure, so no database is
 * involved). What is proved here is the promise the screen makes: after the
 * move, every branch that could be funded stands on the SAME days of cover at
 * its own selling rate — and the edge cases resolve the way the module says
 * they do.
 */

const cover = (onHand: number, qty: number, rate: number) => (onHand + qty) / rate;

describe("sizeTransfers — equal days of cover", () => {
  it("levels every destination to the target cover when the source can afford it", () => {
    const lines = sizeTransfers(
      100,
      [
        { locationId: "empty-shop", onHand: 0, runRate: 2 },
        { locationId: "stocked-shop", onHand: 10, runRate: 1 },
      ],
      14
    );

    const byLocation = new Map(lines.map((l) => [l.toLocationId, l]));
    expect(byLocation.get("empty-shop")!.qty).toBe(28); // 2/day x 14 days
    expect(byLocation.get("stocked-shop")!.qty).toBe(4); // 1/day x 14, less the 10 it holds
    // The point of the whole feature: both branches land on the same cover.
    expect(cover(0, 28, 2)).toBe(14);
    expect(cover(10, 4, 1)).toBe(14);
    expect(byLocation.get("empty-shop")!.toDaysCoverAfter).toBe(14);
    expect(byLocation.get("stocked-shop")!.toDaysCoverAfter).toBe(14);
    // 32 of the 100 available units move; the rest stays in the warehouse.
    expect(lines.reduce((sum, l) => sum + l.qty, 0)).toBe(32);
  });

  it("splits in proportion to each branch's rate when both start empty", () => {
    const lines = sizeTransfers(
      15,
      [
        { locationId: "fast", onHand: 0, runRate: 2 },
        { locationId: "slow", onHand: 0, runRate: 1 },
      ],
      14
    );

    const byLocation = new Map(lines.map((l) => [l.toLocationId, l.qty]));
    expect(byLocation.get("fast")).toBe(10);
    expect(byLocation.get("slow")).toBe(5);
    // Short of the 14-day target, but level: 5 days of cover each.
    expect(cover(0, 10, 2)).toBe(5);
    expect(cover(0, 5, 1)).toBe(5);
  });

  it("closes the gap first when the source can't satisfy everyone", () => {
    const lines = sizeTransfers(
      9,
      [
        { locationId: "empty-shop", onHand: 0, runRate: 1 },
        { locationId: "well-stocked", onHand: 10, runRate: 1 },
      ],
      14
    );

    // All 9 units go to the branch that is short. A proportional split of the
    // 18-unit shortfall would have sent 7 and 2 — leaving 7 days against 12,
    // i.e. preserving exactly the imbalance the plan exists to remove.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.toLocationId).toBe("empty-shop");
    expect(lines[0]!.qty).toBe(9);
    expect(lines[0]!.toDaysCoverAfter).toBe(9);
  });

  it("backfills an oversold branch before topping up a healthy one", () => {
    const lines = sizeTransfers(
      12,
      [
        { locationId: "oversold", onHand: -3, runRate: 1 },
        { locationId: "healthy", onHand: 5, runRate: 1 },
      ],
      14
    );

    const byLocation = new Map(lines.map((l) => [l.toLocationId, l.qty]));
    // Level fill: (12 + (-3) + 5) / 2 = 7 days for both.
    expect(byLocation.get("oversold")).toBe(10);
    expect(byLocation.get("healthy")).toBe(2);
    // Cover BEFORE never reads negative — the hole is a zero shelf, not a debt.
    expect(lines.find((l) => l.toLocationId === "oversold")!.toDaysCoverBefore).toBe(0);
  });
});

describe("sizeTransfers — rounding", () => {
  it("never proposes a fraction of a unit and never over-spends the source", () => {
    const lines = sizeTransfers(
      4,
      [
        { locationId: "slow", onHand: 0, runRate: 1 },
        { locationId: "fast", onHand: 0, runRate: 2 },
      ],
      14
    );

    for (const line of lines) expect(Number.isInteger(line.qty)).toBe(true);
    // 4/3 days of cover each: 1.33 and 2.67 units. The leftover whole unit goes
    // to the larger fractional part (the faster seller), so all 4 units move.
    const byLocation = new Map(lines.map((l) => [l.toLocationId, l.qty]));
    expect(byLocation.get("slow")).toBe(1);
    expect(byLocation.get("fast")).toBe(3);
    expect(lines.reduce((sum, l) => sum + l.qty, 0)).toBe(4);
  });

  it("is deterministic and stays within the source across awkward splits", () => {
    for (let available = 1; available <= 40; available++) {
      const destinations = [
        { locationId: "a", onHand: 1, runRate: 0.7 },
        { locationId: "b", onHand: 0, runRate: 1.3 },
        { locationId: "c", onHand: 9, runRate: 0.9 },
      ];
      const first = sizeTransfers(available, destinations, 14);
      expect(sizeTransfers(available, destinations, 14)).toEqual(first);
      const moved = first.reduce((sum, l) => sum + l.qty, 0);
      expect(moved).toBeLessThanOrEqual(available);
      // Under-ships by at most one unit — a stranded unit is still in the
      // warehouse, an over-shipped one is stock that doesn't exist.
      expect(moved).toBeGreaterThanOrEqual(Math.min(available, 1));
      for (const line of first) expect(line.qty).toBeGreaterThan(0);
    }
  });
});

describe("sizeTransfers — edge cases", () => {
  it("sends nothing to a branch with no run rate", () => {
    const lines = sizeTransfers(
      100,
      [
        { locationId: "new-branch", onHand: 0, runRate: 0 },
        { locationId: "selling-branch", onHand: 0, runRate: 1 },
      ],
      14
    );
    expect(lines.map((l) => l.toLocationId)).toEqual(["selling-branch"]);
  });

  it("proposes nothing when the source holds none of the product", () => {
    expect(sizeTransfers(0, [{ locationId: "shop", onHand: 0, runRate: 5 }], 14)).toEqual([]);
    // A negative (oversold) source position is zero stock, never a debt to push.
    expect(sizeTransfers(-8, [{ locationId: "shop", onHand: 0, runRate: 5 }], 14)).toEqual([]);
  });

  it("leaves a branch alone once it is already past the target cover", () => {
    expect(sizeTransfers(100, [{ locationId: "shop", onHand: 50, runRate: 1 }], 14)).toEqual([]);
  });

  it("proposes nothing when there is no destination at all", () => {
    expect(sizeTransfers(100, [], 14)).toEqual([]);
  });
});

describe("destinationShares — where the per-branch rate comes from", () => {
  it("prefers the branch's own attributed sales", () => {
    const { basis, shareByLocation } = destinationShares([
      { locationId: "busy", onHand: 0, attributedUnits: 30 },
      { locationId: "quiet", onHand: 100, attributedUnits: 10 },
    ]);
    expect(basis).toBe("attributed");
    expect(shareByLocation.get("busy")).toBeCloseTo(0.75, 10);
    expect(shareByLocation.get("quiet")).toBeCloseTo(0.25, 10);
  });

  it("falls back to the stock each branch holds, labelled as an allocation", () => {
    const { basis, shareByLocation } = destinationShares([
      { locationId: "big", onHand: 30, attributedUnits: 0 },
      { locationId: "small", onHand: 10, attributedUnits: 0 },
    ]);
    expect(basis).toBe("allocated");
    expect(shareByLocation.get("big")).toBeCloseTo(0.75, 10);
    expect(shareByLocation.get("small")).toBeCloseTo(0.25, 10);
  });

  it("splits evenly when nobody holds it and nothing is attributed", () => {
    const { basis, shareByLocation } = destinationShares([
      { locationId: "a", onHand: 0, attributedUnits: 0 },
      { locationId: "b", onHand: 0, attributedUnits: 0 },
    ]);
    expect(basis).toBe("even");
    expect(shareByLocation.get("a")).toBe(0.5);
    expect(shareByLocation.get("b")).toBe(0.5);
  });
});
