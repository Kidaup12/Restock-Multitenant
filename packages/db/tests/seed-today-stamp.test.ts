import { describe, expect, it } from "vitest";
import { todaySaleAt } from "../scripts/seed-dev";

/**
 * The seed stamps today's sales an hour ago so a fresh checkout is not judged
 * stale by the next afternoon. The upper end of that clamp was guarded and the
 * lower end was not: seeded between 00:00 and 01:00 UTC, "an hour ago" is
 * yesterday, so today's rows landed on yesterday's day key — beside the day-1
 * rows already stamped there — and today had no sales at all.
 *
 * A test that reads the wall clock passes 23 hours in 24 by luck, so the hour
 * is injected and every one of them is checked.
 */

const DAY_MS = 86_400_000;
const midnightOf = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

describe("the seed's stamp for today", () => {
  const anyDay = Date.UTC(2026, 8, 11);

  it("stays inside today at every hour of the day", () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 1, 30, 59]) {
        const now = anyDay + hour * 3_600_000 + minute * 60_000;
        const stamped = todaySaleAt(now);
        expect(
          stamped,
          `seeded at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC`,
        ).toBeGreaterThanOrEqual(midnightOf(now));
        expect(stamped).toBeLessThan(midnightOf(now) + DAY_MS);
      }
    }
  });

  it("never stamps a sale in the future", () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = anyDay + hour * 3_600_000;
      expect(todaySaleAt(now)).toBeLessThanOrEqual(now);
    }
  });

  it("shares no day key with the day-1 rows, which sit at 20:00 yesterday", () => {
    // The collision that made this worth a test: both stamps formatting to the
    // same YYYY-MM-DD is what merged two days into one bucket.
    const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    for (let hour = 0; hour < 24; hour++) {
      const now = anyDay + hour * 3_600_000 + 30 * 60_000;
      const yesterdayEvening = midnightOf(now) - DAY_MS + 20 * 3_600_000;
      expect(dayKey(todaySaleAt(now))).not.toBe(dayKey(yesterdayEvening));
    }
  });

  it("still backs off from the current instant during the day", () => {
    // Not a midnight constant: the whole point of the stamp is that it is
    // recent, so the staleness gate sees a fresh day.
    const afternoon = anyDay + 16 * 3_600_000;
    expect(todaySaleAt(afternoon)).toBe(afternoon - 3_600_000);
  });
});
