import { describe, expect, it } from "vitest";
import { weightedDailyRateMedianCensored, type SalesPoint } from "../src/baseline";
import { demandRateFor, runRateDaily } from "../src/layered";
import { forecastProduct } from "../src/pipeline";

const today = new Date("2026-10-05T00:00:00Z");
const day = (back: number) => new Date(+today - back * 86400000);
const history = (days = 364, quantity = 1): SalesPoint[] =>
  Array.from({ length: days }, (_, i) => ({ date: day(i + 1), quantity }));
const median = (sales: SalesPoint[], out: Date[] = [], excluded: Date[] = [], since = day(364)) =>
  weightedDailyRateMedianCensored(sales, out, today, excluded, since);

describe("owner-selected weekly median", () => {
  it("preserves established steady demand and the completed-day boundary", () => {
    expect(median(history())).toBeCloseTo(1);
    expect(median([...history(), { date: today, quantity: 10000 }, { date: day(-1), quantity: 10000 }])).toBeCloseTo(1);
    // The oldest included date participates in the eligible exposure fallback.
    expect(median([{ date: day(7), quantity: 7 }])).toBeCloseTo(1);
  });

  it("resists a sustained exceptional week without ignoring established baseline sales", () => {
    const sales = history().map((p) => ({ ...p, quantity: p.date >= day(7) ? 30 : 1 }));
    expect(median(sales)).toBeCloseTo(1);
    expect(runRateDaily(sales, today, [], undefined, day(364))).toBeGreaterThan(1);
  });

  it("aggregates branches/channels before evaluating weekly demand", () => {
    const single = history(364, 2);
    const split = history().flatMap((p) => [{ ...p, channel: "web" }, { ...p, channel: "pos" }]);
    expect(median(split)).toBeCloseTo(median(single));
  });

  it("removes fully unavailable weeks instead of collapsing their median to zero", () => {
    const sales = history().filter((p) => p.date < day(200));
    const unavailable = Array.from({ length: 200 }, (_, i) => day(i + 1));
    expect(median(sales, unavailable)).toBeCloseTo(0.2);
  });

  it("uses an exposure mean when fewer than four usable weeks remain", () => {
    const sales = [{ date: day(60), quantity: 0 }, ...history(10, 2)];
    const unavailable = Array.from({ length: 50 }, (_, i) => day(i + 11));
    expect(median(sales, unavailable)).toBeCloseTo(2);
  });

  it("keeps genuine intermittent demand when most weekly totals are zero", () => {
    const sales = Array.from({ length: 18 }, (_, i) => ({ date: day(1 + i * 21), quantity: 1 }));
    expect(median(sales)).toBeGreaterThan(0.04);
    expect(median(sales)).toBeLessThan(0.07);
  });

  it("excludes closure/promo days from numerator and denominator, including overlaps", () => {
    const excluded = Array.from({ length: 21 }, (_, i) => day(i + 1));
    const sales = history().map((p) => ({ ...p, quantity: p.date >= day(21) ? 1000 : 1 }));
    expect(median(sales, excluded, excluded)).toBeCloseTo(1);
  });

  it("does not turn sale-positive opening-stock snapshots into zero exposure", () => {
    expect(median(history(), history().map((p) => p.date))).toBeCloseTo(1);
  });

  it("normalizes partially stocked weeks and de-duplicates blocked dates", () => {
    const sales = history().filter((_, i) => i % 7 < 3);
    const out = history().filter((_, i) => i % 7 >= 3).map((p) => p.date);
    expect(median(sales, out)).toBeCloseTo(1);
    expect(median(sales, [...out, ...out])).toBeCloseTo(1);
    expect(median(sales)).toBeCloseTo(3 / 7);
  });

  it("uses gap inference only before the snapshot coverage boundary", () => {
    const sales = Array.from({ length: 46 }, (_, i) => ({ date: day(1 + 8 * i), quantity: 8 }));
    const inferred = weightedDailyRateMedianCensored(sales, [], today);
    const knownInStock = median(sales);
    const partial = weightedDailyRateMedianCensored(sales, [], today, [], day(7));
    expect(inferred).toBeGreaterThan(knownInStock);
    expect(partial).toBeGreaterThan(knownInStock);
    expect(partial).toBeLessThan(inferred);
  });

  it("preserves proven stocked zero-sales weeks", () => {
    const sales = history().filter((p) => p.date < day(200));
    const inStock = median(sales);
    const censored = median(sales, Array.from({ length: 200 }, (_, i) => day(i + 1)));
    expect(inStock).toBeGreaterThan(0);
    expect(inStock).toBeLessThan(censored);
  });

  it("keeps default mean and short-history behavior backward compatible", () => {
    const sales = history(20, 2);
    expect(runRateDaily(sales, today, [], undefined, undefined, "median")).toBe(runRateDaily(sales, today));
    expect(runRateDaily(history(), today, [], undefined, undefined, "mean")).toBe(runRateDaily(history(), today));
  });

  it("owner median selection takes precedence over an audition's recent-heavy champion", () => {
    const sales = history().map((p) => ({ ...p, quantity: p.date >= day(7) ? 30 : 1 }));
    expect(demandRateFor("recent_heavy", sales, today, { baselineMethod: "median" })).toBeCloseTo(1);
    expect(demandRateFor("recent_heavy", sales, today)).toBeGreaterThan(1);
  });

  it("passes the choice through the full product pipeline and describes the chosen method", () => {
    const sales = history().map((p) => ({ ...p, quantity: p.date >= day(7) ? 30 : 1 }));
    const input = {
      productId: "sku", product: { sku: "sku", currentStock: 10, onOrder: 0 },
      history: sales, runDateKey: "2026-10-05", abcCategory: "C", snapshotsSince: day(364),
    };
    const selected = forecastProduct({ ...input, baselineMethod: "median" });
    expect(selected.layer1Forecast30d).toBeCloseTo(30);
    expect(selected.reasoning).toContain("weekly-median");
    expect(forecastProduct(input).layer1Forecast30d).toBeGreaterThan(selected.layer1Forecast30d);
  });
});
