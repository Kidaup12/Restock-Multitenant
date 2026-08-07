import { describe, expect, it } from "vitest";
import { trailingWindow } from "../lib/data/trailing-window";

/**
 * One definition of "the last 30 days" for every screen that says it.
 *
 * Today showed two: the revenue tile subtracted 30 days from the current
 * instant and compared it against the date column, while the chart beneath
 * truncated the same instant to a day key and compared that. The truncation
 * made the boundary day inclusive for one and exclusive for the other — so the
 * chart covered 31 days and the tile 30, and one day's revenue landed in the
 * chart's numerator and the tile's denominator. Two "last 30 days" figures a
 * few percent apart, side by side, on the first screen of the day.
 */

// Deliberately mid-afternoon: the whole defect came from a boundary that
// carried a time of day, so a window computed at noon must match one computed
// at midnight.
const AFTERNOON = new Date("2026-08-07T14:23:45.000Z");
const MIDNIGHT = new Date("2026-08-07T00:00:00.000Z");

describe("trailing window", () => {
  it("starts at a UTC midnight, whatever time of day it is asked", () => {
    for (const now of [AFTERNOON, MIDNIGHT, new Date("2026-08-07T23:59:59.999Z")]) {
      expect(trailingWindow(30, now).start.toISOString()).toBe("2026-07-09T00:00:00.000Z");
    }
  });

  it("counts today as one of the days", () => {
    // 30 days ending today is today plus the 29 before it. Off by one here and
    // a per-day average is wrong by a day's trade.
    const w = trailingWindow(30, AFTERNOON);
    const spanDays = (Date.UTC(2026, 7, 7) - +w.start) / 86_400_000 + 1;
    expect(spanDays).toBe(30);
    expect(w.days).toBe(30);
  });

  it("gives the prior window the same length, ending where this one starts", () => {
    const w = trailingWindow(30, AFTERNOON);
    expect(+w.start - +w.priorStart).toBe(30 * 86_400_000);
    expect(w.priorStart.toISOString()).toBe("2026-06-09T00:00:00.000Z");
  });

  it("hands out a day key that matches its own start", () => {
    // The chart compares grouped YYYY-MM-DD keys; the tile compares Dates. They
    // must be the same boundary or the two disagree again.
    const w = trailingWindow(30, AFTERNOON);
    expect(w.startKey).toBe(w.start.toISOString().slice(0, 10));
    expect(w.startKey).toBe("2026-07-09");
  });

  it("works for spans other than 30", () => {
    expect(trailingWindow(7, AFTERNOON).startKey).toBe("2026-08-01");
    expect(trailingWindow(1, AFTERNOON).startKey).toBe("2026-08-07");
  });

  it("crosses a month boundary without drifting", () => {
    expect(trailingWindow(30, new Date("2026-03-05T09:00:00.000Z")).startKey).toBe("2026-02-04");
  });
});
