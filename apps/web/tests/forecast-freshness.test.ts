import { describe, expect, it } from "vitest";
import {
  PLAN_STALE_AFTER_MS,
  isPlanStale,
  planFreshnessLabel,
} from "@/lib/data/forecast-freshness";

/**
 * The rule that decides whether a plan's age is worth saying out loud. The
 * threshold is the whole point: too tight and the banner cries stale every
 * afternoon on a perfectly healthy nightly run, which trains the owner to
 * ignore it.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 5, 8, 0, 0); // 5 Aug, 08:00 — opening time
const hoursAgo = (h: number): Date => new Date(NOW - h * HOUR);

describe("plan freshness", () => {
  it("treats last night's run as fresh at opening time", () => {
    // Computed 02:00 yesterday, read at 08:00 today: 30h old and entirely normal.
    expect(isPlanStale(hoursAgo(30), NOW)).toBe(false);
    const label = planFreshnessLabel(hoursAgo(30), NOW);
    expect(label.tone).toBe("neutral");
    expect(label.text).toContain("Plan computed");
  });

  it("flags a plan only once a night has been missed", () => {
    expect(isPlanStale(hoursAgo(37), NOW)).toBe(true);
    const label = planFreshnessLabel(hoursAgo(37), NOW);
    expect(label.tone).toBe("warning");
    expect(label.text).toContain("2 nights ago");
    expect(label.short).toBe("2 nights out of date");
  });

  it("holds the boundary at 36 hours", () => {
    expect(isPlanStale(new Date(NOW - PLAN_STALE_AFTER_MS), NOW)).toBe(false);
    expect(isPlanStale(new Date(NOW - PLAN_STALE_AFTER_MS - 1), NOW)).toBe(true);
  });

  it("counts nights so they agree with the date printed beside them", () => {
    // The August outage: last run 3 Aug, read on the morning of 5 Aug. Two
    // calendar days, so two nights — anything else contradicts the date shown.
    const label = planFreshnessLabel(new Date(Date.UTC(2026, 7, 3, 2, 0, 0)), NOW);
    expect(label.tone).toBe("warning");
    expect(label.text).toContain("3 Aug");
    expect(label.text).toContain("2 nights ago");
  });

  it("does not let the hour of day change the night count", () => {
    // Same two calendar days apart, read morning and evening.
    const run = new Date(Date.UTC(2026, 7, 3, 2, 0, 0));
    const evening = Date.UTC(2026, 7, 5, 20, 0, 0);
    expect(planFreshnessLabel(run, NOW).text).toContain("2 nights ago");
    expect(planFreshnessLabel(run, evening).text).toContain("2 nights ago");
  });

  it("reads its age coarsely, and agrees with the sentence beside it", () => {
    const run = new Date("2026-08-19T02:00:00Z");
    const at = (ms: number) => planFreshnessLabel(run, run.getTime() + ms);
    expect(at(30_000).relative).toBe("just now");
    expect(at(45 * 60_000).relative).toBe("45m ago");
    expect(at(5 * 3_600_000).relative).toBe("5h ago");
    expect(at(3 * 24 * 3_600_000).relative).toBe("3d ago");
    // Coarse on purpose — nobody acts differently on 4h against 5h, and a
    // minute-accurate pill invites re-reading it.
    expect(at(4 * 3_600_000 + 59 * 60_000).relative).toBe("4h ago");
  });

  it("carries the age on a stale plan too, not just a fresh one", () => {
    const run = new Date("2026-08-14T02:00:00Z");
    const verdict = planFreshnessLabel(run, new Date("2026-08-19T08:00:00Z").getTime());
    expect(verdict.tone).toBe("warning");
    expect(verdict.relative).toBe("5d ago");
  });
});
