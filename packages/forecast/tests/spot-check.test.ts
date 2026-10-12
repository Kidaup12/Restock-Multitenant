import { describe, it, expect } from "vitest";
import { selectSpotChecks, SPOT_CHECK_COUNT, type SpotCandidate } from "../src/spot-check";

const c = (id: string, valueKes: number, runRate = 1, currentStock = 10): SpotCandidate => ({
  id,
  valueKes,
  runRate,
  currentStock,
});

describe("selectSpotChecks", () => {
  it("picks the highest-value moving SKUs, most valuable first", () => {
    const out = selectSpotChecks([c("a", 100), c("b", 500), c("d", 300)], 5);
    expect(out.map((p) => p.id)).toEqual(["b", "d", "a"]);
  });

  it("defaults to five SKUs", () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`p${i}`, 1000 - i));
    expect(selectSpotChecks(many)).toHaveLength(SPOT_CHECK_COUNT);
  });

  it("skips dead SKUs (no run rate)", () => {
    const out = selectSpotChecks([c("dead", 9000, 0), c("alive", 100, 2)]);
    expect(out.map((p) => p.id)).toEqual(["alive"]);
  });

  it("skips empty SKUs (nothing on the shelf to count)", () => {
    const out = selectSpotChecks([c("empty", 9000, 5, 0), c("stocked", 100, 2, 4)]);
    expect(out.map((p) => p.id)).toEqual(["stocked"]);
  });

  it("breaks value ties by run rate, then id — deterministic", () => {
    const out = selectSpotChecks([
      c("slow", 500, 1),
      c("fast", 500, 9),
      c("mid", 500, 5),
    ]);
    expect(out.map((p) => p.id)).toEqual(["fast", "mid", "slow"]);
  });

  it("is stable regardless of input order", () => {
    const a = selectSpotChecks([c("x", 300), c("y", 100), c("z", 200)]);
    const b = selectSpotChecks([c("z", 200), c("x", 300), c("y", 100)]);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
  });
});
