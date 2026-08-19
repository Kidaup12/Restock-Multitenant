import { describe, expect, it } from "vitest";
import { committedValue } from "../components/ui/stepper";

/**
 * What a typed cover horizon or sales-push commits to. Every commit re-plans
 * the buy list on the server, so the rules that matter are the ones that stop a
 * half-finished entry becoming a plan the owner never asked for.
 */

const COVER = { min: 7, max: 120 };

describe("committedValue", () => {
  it("takes a number inside the range", () => {
    expect(committedValue("45", COVER.min, COVER.max)).toBe(45);
  });

  it("clamps rather than refusing an out-of-range answer", () => {
    // Someone typing 999 has said "as long as possible", which is an answer.
    expect(committedValue("999", COVER.min, COVER.max)).toBe(120);
    expect(committedValue("1", COVER.min, COVER.max)).toBe(7);
  });

  it("restores on an empty field, because empty is not zero cover", () => {
    expect(committedValue("", COVER.min, COVER.max)).toBeNull();
    expect(committedValue("   ", COVER.min, COVER.max)).toBeNull();
  });

  it("restores on text rather than planning against NaN", () => {
    expect(committedValue("soon", COVER.min, COVER.max)).toBeNull();
    expect(committedValue("30d", COVER.min, COVER.max)).toBeNull();
  });

  it("rounds a fractional entry — a horizon is whole days", () => {
    expect(committedValue("21.4", COVER.min, COVER.max)).toBe(21);
    expect(committedValue("21.6", COVER.min, COVER.max)).toBe(22);
  });

  it("ignores surrounding whitespace", () => {
    expect(committedValue(" 60 ", COVER.min, COVER.max)).toBe(60);
  });

  it("clamps a negative to the minimum instead of inverting the horizon", () => {
    expect(committedValue("-30", COVER.min, COVER.max)).toBe(7);
  });

  it("works for the sales push, whose floor is zero", () => {
    expect(committedValue("0", 0, 100)).toBe(0);
    expect(committedValue("250", 0, 100)).toBe(100);
  });
});
