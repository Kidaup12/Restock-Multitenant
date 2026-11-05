import { describe, expect, it } from "vitest";
import { isDeadStock, shelfDaysSince } from "../lib/inventory/dead-stock";

const asOf = new Date("2026-10-05T00:00:00Z");
const daysAgo = (n: number) => new Date(+asOf - n * 86_400_000);
const window = (n: number) => ({ currentStock: 10, lastSaleAt: null, cutoff: daysAgo(n), asOf });
const base = window(90);

describe("dead-stock eligibility", () => {
  it("protects never-sold new or unknown-age products", () => {
    for (const firstSeenAt of [undefined, null, daysAgo(1), daysAgo(59)]) {
      expect(isDeadStock({ ...base, firstSeenAt, shelfDays: 90 })).toBe(false);
    }
  });
  it("recognises a never-moved product at the 60-day threshold", () => {
    expect(isDeadStock({ ...base, firstSeenAt: daysAgo(60) })).toBe(true);
    expect(isDeadStock({ ...base, firstSeenAt: daysAgo(60), shelfDays: 90 })).toBe(true);
  });
  it("uses sale recency for previously sold products, even when age is unknown", () => {
    expect(isDeadStock({ ...base, lastSaleAt: daysAgo(91) })).toBe(true);
    expect(isDeadStock({ ...base, lastSaleAt: daysAgo(90) })).toBe(false);
    expect(isDeadStock({ ...base, lastSaleAt: daysAgo(1) })).toBe(false);
  });
  it("never classifies an empty or oversold shelf as dead inventory", () => {
    for (const currentStock of [0, -1]) {
      expect(isDeadStock({ ...base, currentStock, firstSeenAt: daysAgo(300) })).toBe(false);
    }
  });
});

describe("time on shelf is paired with the no-sales window", () => {
  const sold = { lastSaleAt: daysAgo(400) };
  it.each([30, 60, 90])("%dd window: on the shelf the full window → dead", (w) => {
    expect(isDeadStock({ ...window(w), ...sold, shelfDays: w })).toBe(true);
  });
  it.each([30, 60, 90])("%dd window: one day short on the shelf → not dead", (w) => {
    expect(isDeadStock({ ...window(w), ...sold, shelfDays: w - 1 })).toBe(false);
  });
  it("restocked 5 days ago on a 90-day window is protected, though it sold nothing", () => {
    expect(isDeadStock({ ...base, ...sold, shelfDays: 5 })).toBe(false);
  });
  it("a longer window needs a longer shelf time (45 days: dead at 30, not at 60)", () => {
    expect(isDeadStock({ ...window(30), ...sold, shelfDays: 45 })).toBe(true);
    expect(isDeadStock({ ...window(60), ...sold, shelfDays: 45 })).toBe(false);
  });
  it("no shelf evidence leaves the plain no-sales rule unchanged", () => {
    expect(isDeadStock({ ...base, ...sold, shelfDays: null })).toBe(true);
  });
  it("shelf time never overrides a sale in the window or an empty shelf", () => {
    expect(isDeadStock({ ...base, lastSaleAt: daysAgo(10), shelfDays: 90 })).toBe(false);
    expect(isDeadStock({ ...base, ...sold, currentStock: 0, shelfDays: 90 })).toBe(false);
  });
});

describe("shelfDaysSince", () => {
  it("counts days since the last empty day, capped at the window", () => {
    expect(shelfDaysSince(daysAgo(5), 90, asOf)).toBe(5);
    expect(shelfDaysSince(daysAgo(200), 90, asOf)).toBe(90);
    expect(shelfDaysSince(null, 90, asOf)).toBe(90);
    expect(shelfDaysSince(asOf, 90, asOf)).toBe(0);
  });
});
