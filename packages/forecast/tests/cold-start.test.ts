import { describe, it, expect } from "vitest";
import {
  selectProxy,
  isEstablishedProxy,
  borrowedDailyRate,
  borrowedForecast30d,
  PROXY_MIN_HISTORY_DAYS,
  type ProxyCandidate,
  type ProxyTarget,
} from "../src/cold-start";

const target: ProxyTarget = {
  productId: "new-1",
  vendor: "Cantu",
  customCategory: "Hair",
  priceKes: 1000,
};

const established = (over: Partial<ProxyCandidate>): ProxyCandidate => ({
  productId: "p",
  vendor: "Cantu",
  customCategory: "Hair",
  historyDays: 200,
  dailyRate: 4,
  priceKes: 1000,
  ...over,
});

describe("isEstablishedProxy", () => {
  it("needs both a full baseline of history and a real rate", () => {
    expect(isEstablishedProxy({ historyDays: 200, dailyRate: 4 })).toBe(true);
    expect(isEstablishedProxy({ historyDays: PROXY_MIN_HISTORY_DAYS - 1, dailyRate: 4 })).toBe(false);
    expect(isEstablishedProxy({ historyDays: 200, dailyRate: 0 })).toBe(false);
  });
});

describe("selectProxy", () => {
  it("NEVER borrows from another new product", () => {
    const candidates = [
      established({ productId: "also-new", historyDays: 10 }), // too new
      established({ productId: "dead", dailyRate: 0 }), // no rate
    ];
    expect(selectProxy(target, candidates)).toBeNull();
  });

  it("prefers same brand over same category", () => {
    const sameBrand = established({ productId: "brand", vendor: "Cantu", customCategory: "Skin", historyDays: 100 });
    const sameCat = established({ productId: "cat", vendor: "Nivea", customCategory: "Hair", historyDays: 300 });
    expect(selectProxy(target, [sameCat, sameBrand])!.productId).toBe("brand");
  });

  it("within a tier, the most history wins", () => {
    const a = established({ productId: "a", historyDays: 100 });
    const b = established({ productId: "b", historyDays: 250 });
    expect(selectProxy(target, [a, b])!.productId).toBe("b");
  });

  it("falls back to category when no brand match exists", () => {
    const catOnly = established({ productId: "cat", vendor: "Other", customCategory: "Hair" });
    expect(selectProxy(target, [catOnly])!.productId).toBe("cat");
  });

  it("never selects the target itself", () => {
    const self = established({ productId: "new-1" });
    expect(selectProxy(target, [self])).toBeNull();
  });

  it("returns null with no similar established product (honest 'too new')", () => {
    const unrelated = established({ productId: "u", vendor: "Zzz", customCategory: "Makeup" });
    expect(selectProxy(target, [unrelated])).toBeNull();
  });
});

describe("borrowedDailyRate", () => {
  it("borrows the rate as-is when prices match", () => {
    expect(borrowedDailyRate(4, { priceKes: 1000 }, { priceKes: 1000 })).toBe(4);
  });

  it("a cheaper target than its proxy sells more units (scaled up, clamped)", () => {
    // proxy 1000, target 500 -> ratio 2 -> 4 * 2
    expect(borrowedDailyRate(4, { priceKes: 500 }, { priceKes: 1000 })).toBe(8);
    // extreme gap clamps at 2x
    expect(borrowedDailyRate(4, { priceKes: 100 }, { priceKes: 1000 })).toBe(8);
  });

  it("falls back to the raw rate when a price is missing", () => {
    expect(borrowedDailyRate(4, {}, { priceKes: 1000 })).toBe(4);
  });

  it("borrowedForecast30d is the scaled rate over 30 days", () => {
    const proxy = established({ dailyRate: 3, priceKes: 1000 });
    expect(borrowedForecast30d(proxy, { ...target, priceKes: 1000 })).toBe(90);
  });
});
