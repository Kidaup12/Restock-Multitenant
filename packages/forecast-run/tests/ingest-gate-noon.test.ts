import { describe, expect, it } from "vitest";
import { assessTenantIngest } from "../src/run";

/**
 * The gate that decides whether a fresh forecast may be written.
 *
 * Sales carry a UTC-midnight day marker rather than a timestamp, and the gate
 * used to exclude today from the freshness question as well as from the volume
 * question. The freshest a feed could then ever look was yesterday-midnight —
 * which crossed the 36-hour threshold at exactly noon, so every shop with a real
 * trading history was declared "no recent sales" for the back half of every day
 * and refused its forecast. One shop went from 14:37 one day to 03:07 the next
 * with nothing in between.
 */

const DAY = 86_400_000;
const atUtc = (isoDay: string, hhmm: string) => new Date(`${isoDay}T${hhmm}:00Z`);
const marker = (d: Date) => {
  const m = new Date(d);
  m.setUTCHours(0, 0, 0, 0);
  return m;
};

/** A shop that trades every day for `days` days, ending `endingDaysAgo` ago. */
function trading(now: Date, days: number, endingDaysAgo = 0) {
  return Array.from({ length: days }, (_, i) => ({
    date: marker(new Date(+now - (i + endingDaysAgo) * DAY)),
    quantity: 20,
  }));
}

describe("the forecast is not refused for half of every day", () => {
  it("a shop that sold today is fresh at 11:59 and still fresh at 12:01", () => {
    const beforeNoon = atUtc("2026-09-11", "11:59");
    const afterNoon = atUtc("2026-09-11", "12:01");

    for (const now of [beforeNoon, afterNoon]) {
      const v = assessTenantIngest(trading(now, 30), now);
      expect(v.stale, `called stale at ${now.toISOString()}`).toBe(false);
      expect(v.stop, `forecast refused at ${now.toISOString()}`).toBe(false);
    }
  });

  it("a shop closed for a single day is not called broken", () => {
    // Sunday closures are ordinary. One quiet day is not a stopped feed.
    const now = atUtc("2026-09-11", "18:00");
    const v = assessTenantIngest(trading(now, 30, 1), now);
    expect(v.stale).toBe(false);
    expect(v.stop).toBe(false);
  });

  it("resumes the moment sales come back, without waiting out the gap", () => {
    // Two quiet days, then trading again TODAY. Today's rows are a partial day,
    // so they cannot be compared against a normal day's volume — but they are
    // still data that arrived, and a shop that is selling right now must not be
    // held on the strength of the silence before it.
    const now = atUtc("2026-09-11", "18:00");
    const resumed = [
      { date: marker(now), quantity: 20 },
      ...trading(now, 30, 3),
    ];
    const v = assessTenantIngest(resumed, now);
    expect(v.stale, "held a shop that is trading today").toBe(false);
    expect(v.stop, "refused a forecast to a shop that is trading today").toBe(false);
  });

  it("still stops when the feed has genuinely gone quiet", () => {
    // Three days of silence is the thing the gate exists to catch.
    const now = atUtc("2026-09-11", "18:00");
    const v = assessTenantIngest(trading(now, 30, 3), now);
    expect(v.stale).toBe(true);
    expect(v.stop).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/newest sale on record/i);
  });
});
