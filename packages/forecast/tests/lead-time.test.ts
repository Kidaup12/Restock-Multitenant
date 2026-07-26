import { describe, it, expect } from "vitest";
import {
  ASSUMED_LEAD_DAYS,
  coverDaysFor,
  leadDaysFor,
  leadStdFor,
  ORDER_REVIEW_DAYS,
} from "../src/lead-time";

describe("leadDaysFor precedence", () => {
  it("per-product override wins over the supplier average", () => {
    expect(leadDaysFor({ leadTimeDays: 11 }, { leadTimeAvgDays: 14 })).toBe(11);
  });
  it("supplier average wins when the product has no override", () => {
    expect(leadDaysFor({ leadTimeDays: null }, { leadTimeAvgDays: 14 })).toBe(14);
  });
  it("no real data → null, NEVER a guess (guesses inflate orders)", () => {
    expect(leadDaysFor({ leadTimeDays: null }, null)).toBeNull();
    expect(leadDaysFor({ leadTimeDays: null }, undefined)).toBeNull();
    expect(leadDaysFor({}, null)).toBeNull();
  });
  it("leadTimeDays 0 is a valid explicit override (same-day)", () => {
    expect(leadDaysFor({ leadTimeDays: 0 }, { leadTimeAvgDays: 14 })).toBe(0);
  });
});

describe("leadStdFor", () => {
  it("supplier std wins when present", () => {
    expect(leadStdFor({ leadTimeStdDays: 4 })).toBe(4);
  });
  it("no supplier std → one flat fallback (±7)", () => {
    expect(leadStdFor(null)).toBe(7);
    expect(leadStdFor(undefined)).toBe(7);
    expect(leadStdFor({})).toBe(7);
  });
});

describe("coverDaysFor (item lead time + review cycle, no hard-coded policy)", () => {
  it("uses the per-product lead override when present", () => {
    expect(coverDaysFor({ leadTimeDays: 14 }, { leadTimeAvgDays: 28 })).toBe(14 + ORDER_REVIEW_DAYS);
  });
  it("uses the supplier's average lead when the product has no override", () => {
    expect(coverDaysFor({ leadTimeDays: null }, { leadTimeAvgDays: 5 })).toBe(5 + ORDER_REVIEW_DAYS);
  });
  it("no lead data covers the review cycle only — no guess", () => {
    expect(coverDaysFor({})).toBe(ORDER_REVIEW_DAYS);
    expect(coverDaysFor({ leadTimeDays: null }, null)).toBe(ORDER_REVIEW_DAYS);
  });
  it("the urgency assumption never leaks into the order size", () => {
    expect(coverDaysFor({ leadTimeDays: null }, null)).toBeLessThan(ASSUMED_LEAD_DAYS);
  });
});

describe("ASSUMED_LEAD_DAYS (the one urgency fallback)", () => {
  it("is a real waiting time, so an unknown lead never reads as same-day", () => {
    expect(ASSUMED_LEAD_DAYS).toBeGreaterThan(0);
  });
  it("is slow enough to sit outside the this-week tier", () => {
    // A tier boundary of 7 days: assuming anything faster would still tell the
    // owner they have a week in hand for a supplier they have never timed.
    expect(ASSUMED_LEAD_DAYS).toBeGreaterThan(ORDER_REVIEW_DAYS);
  });
});
