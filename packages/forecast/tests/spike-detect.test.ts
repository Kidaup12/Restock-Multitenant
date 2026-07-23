import { describe, it, expect } from "vitest";
import { detectSpikes, SPIKE_MULTIPLE } from "../src/spike-detect";

const ASOF = new Date("2026-07-21T00:00:00Z");
const day = (daysAgo: number, qty: number) => ({ date: new Date(+ASOF - daysAgo * 86_400_000), quantity: qty });

// A steady ~2/day seller for 60 days (median baseline = 2).
const steady = Array.from({ length: 60 }, (_, i) => day(i + 1, 2));

describe("detectSpikes", () => {
  it("flags a recent day that sold >=3x baseline and >=8 units", () => {
    const history = [...steady, day(3, 40)]; // 40 vs baseline 2 = 20x
    const spikes = detectSpikes(history, [], ASOF);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.quantity).toBe(40);
    expect(spikes[0]!.baseline).toBe(2);
    expect(spikes[0]!.multiple).toBe(20);
  });

  it("does NOT flag a day already inside a logged promo window", () => {
    const spikeDay = day(3, 40);
    const history = [...steady, spikeDay];
    const window = { start: day(4, 0).date, end: day(2, 0).date };
    expect(detectSpikes(history, [window], ASOF)).toHaveLength(0);
  });

  it("ignores small absolute jumps (0.2 → 1 is not a spike)", () => {
    const slow = Array.from({ length: 60 }, (_, i) => day(i + 1, i % 5 === 0 ? 1 : 0));
    const history = [...slow, day(2, 3)]; // 3 units — below the 8-unit floor
    expect(detectSpikes(history, [], ASOF)).toHaveLength(0);
  });

  it("ignores spikes older than the lookback window", () => {
    const history = [...steady, day(30, 40)]; // 30 days ago, default lookback 14
    expect(detectSpikes(history, [], ASOF)).toHaveLength(0);
  });

  it("returns the biggest surprise first", () => {
    const history = [...steady, day(2, 12), day(4, 60)];
    const spikes = detectSpikes(history, [], ASOF);
    expect(spikes.map((s) => s.quantity)).toEqual([60, 12]);
  });

  it("no baseline (never sold) → no spikes, no crash", () => {
    expect(detectSpikes([day(2, 40)], [], ASOF)).toEqual([]);
  });

  it("SPIKE_MULTIPLE threshold: 2.9x is not flagged, 3x is", () => {
    const base = Array.from({ length: 60 }, (_, i) => day(i + 1, 10)); // baseline 10
    expect(detectSpikes([...base, day(2, 29)], [], ASOF)).toHaveLength(0); // 2.9x
    expect(detectSpikes([...base, day(2, 30)], [], ASOF)).toHaveLength(1); // 3.0x
    expect(SPIKE_MULTIPLE).toBe(3);
  });
});
