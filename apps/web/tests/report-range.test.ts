import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANGE,
  RANGE_KEYS,
  parseRangeKey,
  rangeDays,
  rangeLabel,
  rangeShortLabel,
  rangeWeeks,
} from "../lib/data/report-range";

/**
 * The Reports period.
 *
 * The table-completeness case is the one that earns its place: a key added to
 * RANGE_KEYS without an entry beside it would sail through typecheck via the
 * Record type only until someone widened the type, and would then render
 * "undefined" in a chip. Two lists that must agree, kept honest by a test.
 */

describe("the report range", () => {
  it("gives every key both a duration and words for it", () => {
    for (const key of RANGE_KEYS) {
      expect(rangeDays(key), `${key} has no day count`).toBeGreaterThan(0);
      expect(rangeLabel(key), `${key} has no label`).toBeTruthy();
      expect(rangeShortLabel(key), `${key} has no chip label`).toBeTruthy();
    }
  });

  it("falls back rather than throwing on anything a visitor can type", () => {
    // A query string is user input. A report that breaks on a typo is worse
    // than one that shows its usual window.
    for (const junk of [null, undefined, "", "  ", "30", "last-month", "'; drop table"]) {
      expect(parseRangeKey(junk)).toBe(DEFAULT_RANGE);
    }
  });

  it("keeps a valid key", () => {
    for (const key of RANGE_KEYS) expect(parseRangeKey(key)).toBe(key);
  });

  it("defaults to the window every figure was previously hardcoded to", () => {
    // So an existing link, or a bookmark, reads exactly as it did before the
    // control existed.
    expect(rangeDays(DEFAULT_RANGE)).toBe(30);
  });

  it("orders the ranges longest-last, so the rail reads left to right", () => {
    const days = RANGE_KEYS.map(rangeDays);
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  it("never asks a weekly panel for zero weeks", () => {
    // 7 days rounds to exactly one week; anything shorter must still ask for one.
    for (const key of RANGE_KEYS) expect(rangeWeeks(key)).toBeGreaterThanOrEqual(1);
    expect(rangeWeeks("7d")).toBe(1);
    expect(rangeWeeks("90d")).toBe(13);
  });
});
