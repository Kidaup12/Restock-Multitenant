import { describe, expect, it } from "vitest";
import { isDeadStock } from "../lib/inventory/dead-stock";

const asOf = new Date("2026-10-05T00:00:00Z");
const daysAgo = (n: number) => new Date(+asOf - n * 86_400_000);
const base = { currentStock: 10, lastSaleAt: null, cutoff: daysAgo(90), asOf };

describe("original dead-stock eligibility", () => {
  it("protects never-sold new or unknown-age products even with 14 stocked observations", () => {
    for (const firstSeenAt of [undefined, null, daysAgo(1), daysAgo(59)]) {
      expect(isDeadStock({ ...base, firstSeenAt, inStockDays: 14 })).toBe(false);
    }
  });
  it("recognises a never-moved product at the original 60-day threshold", () => {
    expect(isDeadStock({ ...base, firstSeenAt: daysAgo(60) })).toBe(true);
    expect(isDeadStock({ ...base, firstSeenAt: daysAgo(60), inStockDays: 14 })).toBe(true);
  });
  it("protects newly restocked products despite old sales and old product age", () => {
    for (const inStockDays of [0, 1, 13]) {
      expect(isDeadStock({ ...base, firstSeenAt: daysAgo(300), lastSaleAt: daysAgo(100), inStockDays })).toBe(false);
    }
    expect(isDeadStock({ ...base, lastSaleAt: daysAgo(100), inStockDays: 14 })).toBe(true);
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
