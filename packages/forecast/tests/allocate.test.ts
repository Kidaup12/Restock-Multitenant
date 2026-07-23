import { describe, it, expect } from "vitest";
import { allocateByBudget } from "../src/allocate";

/**
 * The buy-list allocator is the heart of the restock planner: a tiny budget
 * must NOT return a full buy list. Items are assumed already sorted by score
 * (desc) and already filtered to a positive cost upstream.
 */

type Item = { id: string; cost: number; urgency: string };
const item = (id: string, cost: number, urgency = "medium"): Item => ({ id, cost, urgency });

describe("allocateByBudget", () => {
  it("a tiny budget buys nothing when every item costs more than it", () => {
    const scored = [item("a", 200), item("b", 350), item("c", 500)];
    const { selected, deferred, usedKes } = allocateByBudget(scored, 8);
    expect(selected).toEqual([]);
    expect(deferred.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(usedKes).toBe(0);
  });

  it("fills greedily in score order and respects the budget cap", () => {
    // sorted by score already: a, b, c. Budget fits a+b (550) but not c.
    const scored = [item("a", 200), item("b", 350), item("c", 500)];
    const { selected, deferred, usedKes } = allocateByBudget(scored, 600);
    expect(selected.map((x) => x.id)).toEqual(["a", "b"]);
    expect(deferred.map((x) => x.id)).toEqual(["c"]);
    expect(usedKes).toBe(550);
  });

  it("always includes criticals even when they overflow the budget", () => {
    const scored = [item("crit", 1000, "critical"), item("a", 200)];
    const { selected, usedKes } = allocateByBudget(scored, 8);
    expect(selected.map((x) => x.id)).toContain("crit");
    expect(usedKes).toBe(1000); // overflow is surfaced by the caller, not hidden
  });

  it("with no budget selects everything needed", () => {
    const scored = [item("a", 200), item("b", 350), item("c", 500)];
    const { selected, deferred, usedKes } = allocateByBudget(scored, null);
    expect(selected.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(deferred).toEqual([]);
    expect(usedKes).toBe(1050);
  });

  it("never lets a non-critical item exceed the remaining budget", () => {
    // a (critical, 1000) eats the budget; b must defer even though it is cheap.
    const scored = [item("a", 1000, "critical"), item("b", 50)];
    const { selected, deferred } = allocateByBudget(scored, 800);
    expect(selected.map((x) => x.id)).toEqual(["a"]);
    expect(deferred.map((x) => x.id)).toEqual(["b"]);
  });

  it("strict mode never exceeds the budget — a critical that doesn't fit is deferred", () => {
    const scored = [item("crit", 1000, "critical"), item("a", 200), item("b", 350)];
    const { selected, deferred, usedKes } = allocateByBudget(scored, 600, true);
    expect(selected.map((x) => x.id)).toEqual(["a", "b"]);
    expect(deferred.map((x) => x.id)).toEqual(["crit"]);
    expect(usedKes).toBe(550);
    expect(usedKes).toBeLessThanOrEqual(600);
  });
});
