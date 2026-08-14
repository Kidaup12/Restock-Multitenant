import { describe, expect, it } from "vitest";
import { syncBackoffDelay } from "../src";

const rateLimited = (retryAfterMs: number) => ({ retryAfterMs });

describe("syncBackoffDelay (rate-limited)", () => {
  it("spreads identical rate limits across a window", () => {
    const delays = new Set(
      Array.from({ length: 50 }, () => syncBackoffDelay(1, rateLimited(30_000)))
    );
    // Every tenant in a 429 storm gets the same Retry-After; if they all wait
    // the same number of milliseconds they come back as one thundering herd.
    expect(delays.size).toBeGreaterThan(1);
  });

  it("waits longer on each successive attempt", () => {
    // rand pinned so only attemptsMade varies.
    const zero = () => 0;
    let previous = 0;
    for (const attemptsMade of [1, 2, 3, 4]) {
      const delay = syncBackoffDelay(attemptsMade, rateLimited(5_000), zero);
      expect(delay).toBeGreaterThan(previous);
      previous = delay;
    }
  });

  it("never retries earlier than the provider allowed", () => {
    for (const retryAfterMs of [1, 750, 30_000, 10 * 60_000]) {
      for (const attemptsMade of [0, 1, 3, 6, 12]) {
        for (const rand of [() => 0, () => 0.5, () => 0.999_999]) {
          expect(syncBackoffDelay(attemptsMade, rateLimited(retryAfterMs), rand)).toBeGreaterThanOrEqual(
            retryAfterMs
          );
        }
      }
    }
  });

  it("keeps a ceiling on the wait", () => {
    expect(syncBackoffDelay(40, rateLimited(30_000), () => 0.999)).toBeLessThanOrEqual(10 * 60_000);
  });

  it("ignores a retryAfterMs that is not a usable number", () => {
    for (const err of [{ retryAfterMs: 0 }, { retryAfterMs: -5 }, { retryAfterMs: "30s" }, {}, undefined]) {
      expect(syncBackoffDelay(2, err, () => 0.9)).toBe(4_000);
    }
  });
});

describe("syncBackoffDelay (everything else)", () => {
  it("doubles each attempt and caps at one minute", () => {
    const err = new Error("network");
    expect(syncBackoffDelay(0, err)).toBe(1_000);
    expect(syncBackoffDelay(3, err)).toBe(8_000);
    expect(syncBackoffDelay(6, err)).toBe(60_000);
    expect(syncBackoffDelay(20, err)).toBe(60_000);
  });
});
