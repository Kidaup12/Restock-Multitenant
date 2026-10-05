import { describe, expect, it } from "vitest";
import { salesReviewDays } from "../lib/signals/sales-review";

const asOf = new Date("2026-10-05T12:00:00Z");
const day = (n: number) => new Date(Date.UTC(2026, 9, 5 - n));
const product = { sku: "SER", vendor: "Brand", productType: "Skin" };
const history = Array.from({ length: 30 }, (_, i) => ({ date: day(i + 2), quantity: 1 }));
const review = (quantity: number, promos: Parameters<typeof salesReviewDays>[0]["promos"] = []) =>
  salesReviewDays({ history: [...history, { date: day(1), quantity }], product, promos, asOf });

describe("bulk and unusual sales review", () => {
  it("flags seven units on a typical one-unit day, missed by the old eight-unit detector", () => {
    expect(review(7)).toEqual([{ dayKey: "2026-10-04", quantity: 7, baseline: 1,
      multiple: 7, kind: "possible_bulk", threshold: 6 }]);
    expect(review(6)).toEqual([]);
  });
  it("adds channels and branches before either detector and produces one flag per day", () => {
    const rows = history.flatMap(p => [{ ...p }, { ...p }]);
    const result = salesReviewDays({ history: [...rows, { date: day(1), quantity: 7 }, { date: day(1), quantity: 7 }, { date: day(1), quantity: 7 }], product, promos: [], asOf });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ quantity: 21, baseline: 2, kind: "possible_bulk" });
    const generic = salesReviewDays({ history: [...rows, { date: day(1), quantity: 4 }, { date: day(1), quantity: 4 }], product, promos: [], asOf });
    expect(generic[0]).toMatchObject({ quantity: 8, baseline: 2, kind: "unusual_day" });
  });
  it("does not let another product's promotion conceal this product's bulk day", () => {
    const promo = { startDate: day(1), endDate: day(1), scope: "sku", scopeValue: "OTHER" };
    expect(review(20, [promo])).toHaveLength(1);
    expect(review(20, [{ ...promo, scopeValue: "SER" }])).toEqual([]);
    expect(review(20, [{ ...promo, scope: "brand", scopeValue: "brand" }])).toEqual([]);
  });
  it("keeps longer-history bulk evidence and rejects future imports", () => {
    const result = salesReviewDays({ history: [...history, { date: day(100), quantity: 20 }, { date: day(-1), quantity: 100 }], product, promos: [], asOf });
    expect(result).toHaveLength(1);
    expect(result[0].dayKey).toBe(day(100).toISOString().slice(0, 10));
  });
  it("never invents a bulk buyer from an ordinary steady series", () => {
    expect(salesReviewDays({ history, product, promos: [], asOf })).toEqual([]);
  });
});
