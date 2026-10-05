import { describe, expect, it } from "vitest";
import { debulkSeries, hasBulkBuy, BULK_MULT, BULK_ABS_FLOOR, BULK_CAP_MULT } from "../src/big-buyer";

const today = new Date("2026-10-05T00:00:00Z");
const point = (back: number, quantity: number) => ({ date: new Date(+today - back * 86400000), quantity });
const steady = (quantity = 2) => Array.from({ length: 30 }, (_, i) => point(i + 2, quantity));

describe("original bulk-day classifier and optional cleaner", () => {
  it("retains original thresholds and caps a 50-unit day among 2-unit days to six", () => {
    expect([BULK_MULT, BULK_ABS_FLOOR, BULK_CAP_MULT]).toEqual([5, 6, 3]);
    const result = debulkSeries([...steady(), point(1, 50)]);
    expect(result.caps).toEqual([{ date: point(1, 0).date, original: 50, capped: 6, baseline: 2,
      threshold: 10, multiple: 25, evidence: "daily_total" }]);
    expect(result.series.at(-1)!.quantity).toBe(6);
  });

  it("does not flag equal-threshold sales or ordinary low-volume variation", () => {
    expect(hasBulkBuy([...steady(), point(1, 10)])).toBe(false);
    expect(hasBulkBuy([...steady(), point(1, 11)])).toBe(true);
    expect(hasBulkBuy([...steady(1), point(1, 6)])).toBe(false);
    const result = debulkSeries([...steady(1), point(1, 7)]);
    expect(result.caps[0]!.capped).toBe(5);
  });

  it("combines split branch/channel rows into one daily anomaly", () => {
    const rows = [...steady(), point(1, 8), point(1, 8)];
    const result = debulkSeries(rows);
    expect(result.caps).toHaveLength(1);
    expect(result.caps[0]!.original).toBe(16);
    expect(result.series.slice(-2).map((p) => p.quantity)).toEqual([3, 3]);
  });

  it("does not invent low medians by treating many channels as many sale days", () => {
    const normal = Array.from({ length: 30 }, (_, i) => Array.from({ length: 10 }, () => point(i + 2, 1))).flat();
    expect(debulkSeries([...normal, point(1, 30)]).caps).toEqual([]);
  });

  it("preserves row metadata and historical revenue without mutating stored facts", () => {
    const rows = [...steady(), point(1, 50)].map((p) => ({ ...p, channel: "pos", locationId: "branch", revenueKes: p.quantity * 100 }));
    const before = structuredClone(rows);
    const result = debulkSeries(rows);
    expect(rows).toEqual(before);
    expect(result.series.at(-1)).toMatchObject({ channel: "pos", locationId: "branch", revenueKes: 5000, quantity: 6 });
    expect(result.series[0]).not.toBe(rows[0]);
  });

  it("leaves returns intact while the net capped day remains at target", () => {
    const result = debulkSeries([...steady(), point(1, 50), point(1, -10)]);
    expect(result.caps[0]!.original).toBe(40);
    expect(result.series.at(-1)!.quantity).toBe(-10);
    expect(result.series.slice(-2).reduce((s, p) => s + p.quantity, 0)).toBeCloseTo(6);
  });

  it("when asOf is supplied excludes current and future days from detection and median", () => {
    const rows = [...steady(), point(0, 500), point(-1, 500), point(1, 50)];
    const result = debulkSeries(rows, { asOf: today });
    expect(result.caps).toHaveLength(1);
    expect(result.caps[0]!.original).toBe(50);
    expect(result.series.slice(-3, -1).map((p) => p.quantity)).toEqual([500, 500]);
  });

  it("does not flag already-explained promo days or use them to contaminate the baseline", () => {
    const result = debulkSeries([...steady(), point(1, 50)], { excludedDates: [point(1, 0).date] });
    expect(result.caps).toEqual([]);
    expect(result.series.at(-1)!.quantity).toBe(50);
  });

  it("keeps empty, zero-only and one-sale histories unchanged", () => {
    expect(debulkSeries([])).toEqual({ series: [], caps: [] });
    for (const rows of [[point(1, 0)], [point(1, 100)]]) {
      expect(debulkSeries(rows).caps).toEqual([]);
      expect(debulkSeries(rows).series).toEqual(rows);
    }
  });

  it("labels only day-level evidence even for very large totals", () => {
    const result = debulkSeries([...steady(), point(1, 1000)]);
    expect(result.caps[0]!.evidence).toBe("daily_total");
    expect(result.caps[0]).not.toHaveProperty("receiptId");
  });
});
