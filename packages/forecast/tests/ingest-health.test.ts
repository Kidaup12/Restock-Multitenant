import { describe, it, expect } from "vitest";
import {
  assessIngestHealth,
  DEFAULT_INGEST_HEALTH,
  type DailyPoint,
} from "../src/ingest-health";

const DAY = 86_400_000;

/** A steady series of `n` completed days at `units`/day ending `endKey`. */
function steady(n: number, units: number, endKey: number): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (let i = n - 1; i >= 0; i--) out.push({ dayKey: endKey - i * DAY, units });
  return out;
}

const now = new Date("2026-08-20T12:00:00Z");
const lastCompletedKey = Date.UTC(2026, 7, 19); // Aug 19

describe("assessIngestHealth", () => {
  it("passes a healthy, fresh feed", () => {
    const daily = steady(30, 20, lastCompletedKey);
    const v = assessIngestHealth(daily, new Date("2026-08-20T06:00:00Z"), now);
    expect(v.ok).toBe(true);
    expect(v.stop).toBe(false);
    expect(v.stale).toBe(false);
    expect(v.gapDayKeys).toHaveLength(0);
  });

  it("STOPS when the newest sale is older than maxStaleHours", () => {
    const daily = steady(30, 20, lastCompletedKey);
    const old = new Date(now.getTime() - 48 * 3_600_000); // 48h ago > 36h default
    const v = assessIngestHealth(daily, old, now);
    expect(v.stale).toBe(true);
    expect(v.stop).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/feed looks stopped/i);
  });

  it("STOPS when the feed never connected (no latest sale)", () => {
    const v = assessIngestHealth([], null, now);
    expect(v.stop).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/never have connected/i);
  });

  it("IMPUTES a short recoverable gap (1-2 low days), does not stop", () => {
    // 28 normal days then 2 near-empty days at the end.
    const daily = [
      ...steady(28, 20, lastCompletedKey - 2 * DAY),
      { dayKey: lastCompletedKey - DAY, units: 0 },
      { dayKey: lastCompletedKey, units: 1 },
    ];
    const v = assessIngestHealth(daily, new Date("2026-08-20T06:00:00Z"), now);
    expect(v.stop).toBe(false);
    expect(v.impute).toBe(true);
    expect(v.gapDayKeys.length).toBeGreaterThan(0);
    expect(v.gapDayKeys.length).toBeLessThanOrEqual(DEFAULT_INGEST_HEALTH.maxImputeDays);
  });

  it("STOPS when too many recent days are far below normal (real outage)", () => {
    // 24 normal days then 5 near-empty days — more than maxImputeDays (2).
    const daily = [
      ...steady(24, 20, lastCompletedKey - 5 * DAY),
      ...steady(5, 0, lastCompletedKey),
    ];
    const v = assessIngestHealth(daily, new Date("2026-08-20T06:00:00Z"), now);
    expect(v.stop).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/too many to safely patch/i);
  });

  it("does not second-guess a genuinely slow tiny shop (norm below minNorm)", () => {
    // ~2 units/day: below minNorm (10). A zero day is natural, not a gap.
    const daily = [
      ...steady(28, 2, lastCompletedKey - DAY),
      { dayKey: lastCompletedKey, units: 0 },
    ];
    const v = assessIngestHealth(daily, new Date("2026-08-20T06:00:00Z"), now);
    expect(v.gapDayKeys).toHaveLength(0);
    expect(v.stop).toBe(false);
  });

  it("upper-half norm resists a cluster of gap days (outage not hidden)", () => {
    // Feed down 4 of the last 7 days. A plain median would sink; p75 stays anchored
    // to the trading days, so the outage is still detected as a STOP.
    const daily = [
      ...steady(23, 20, lastCompletedKey - 4 * DAY),
      ...steady(4, 0, lastCompletedKey),
    ];
    const v = assessIngestHealth(daily, new Date("2026-08-20T06:00:00Z"), now);
    expect(v.stop).toBe(true);
  });
});
