import { describe, it, expect } from "vitest";
import { layeredForecast, type ForecastInput } from "../src/layered";

const RUN_KEY = "2026-07-21";
const TODAY = new Date(`${RUN_KEY}T00:00:00Z`);
const day = (daysAgo: number) => new Date(+TODAY - daysAgo * 864e5);

function baseInput(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    productId: "p1",
    productType: "SERUM",
    vendor: "ACME",
    sku: "SKU-1",
    currentStock: 10,
    abcCategory: "B",
    history: [],
    leadTimeAvg: 7,
    leadTimeStd: 2,
    activePromos: [],
    runDateKey: RUN_KEY,
    ...overrides,
  };
}

/** Steady 2/day seller for `days` days ending yesterday. */
const steady = (days: number, qty = 2) =>
  Array.from({ length: days }, (_, i) => ({ date: day(i + 1), quantity: qty }));

describe("cold start", () => {
  it("no history at all → honest 'too new', not a silent dead-listing zero", () => {
    const r = layeredForecast(baseInput({ history: [], currentStock: 0 }));
    expect(r.finalForecast30d).toBe(0);
    expect(r.recommendedQty).toBe(0);
    expect(r.urgency).toBe("low");
    expect(r.confidence).toBe(0.3);
    expect(r.reasoning).toContain("too new to forecast");
    expect(r.signals.some((s) => s.label.includes("no sales history"))).toBe(true);
  });

  it("short history rates over its own window: 2/day over 10 days reads ~2/day, not 20/30", () => {
    const r = layeredForecast(baseInput({ history: steady(10) }));
    // 20 units / 10 observed days — a fixed 30-day denominator would say 0.67/day.
    expect(r.finalForecast30d).toBeGreaterThan(50);
    expect(r.finalForecast30d).toBeLessThanOrEqual(62);
    expect(r.signals.some((s) => s.label.startsWith("New product"))).toBe(true);
    expect(r.reasoning).toContain("new product");
  });

  it("a very short window still keeps the conservative 7-day floor", () => {
    // 10 units on a product first seen 3 days ago → 10/7, not 10/3.
    const r = layeredForecast(baseInput({ history: [{ date: day(3), quantity: 10 }] }));
    expect(r.layer1Forecast30d).toBeCloseTo((10 / 7) * 30, 1);
  });

  it("new-product confidence is capped at 0.5", () => {
    const r = layeredForecast(baseInput({ history: steady(10) }));
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(r.confidence).toBeGreaterThanOrEqual(0.3);
  });

  it("a mature product is not flagged new and can report higher confidence", () => {
    const r = layeredForecast(baseInput({ history: steady(90) }));
    expect(r.signals.some((s) => s.label.startsWith("New product"))).toBe(false);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
});

describe("dead listings", () => {
  it("zero run rate with real history → nothing recommended, never a stockout emergency", () => {
    // Sold once, 400 days ago; nothing since. Zero stock.
    const r = layeredForecast(
      baseInput({ history: [{ date: day(400), quantity: 1 }], currentStock: 0 })
    );
    expect(r.finalForecast30d).toBe(0);
    expect(r.recommendedQty).toBe(0);
    expect(r.urgency).toBe("low");
    expect(r.signals.some((s) => s.label.startsWith("New product"))).toBe(false);
  });
});

describe("stockout-corrected demand", () => {
  const history = [
    { date: day(400), quantity: 1 }, // old anchor: mature product
    ...steady(10), // 2/day on the 10 days it was actually on the shelf
  ];
  const stockouts = Array.from({ length: 20 }, (_, i) => day(i + 11)); // out 20 of last 30

  it("an out-of-stock stretch corrects demand up instead of reading as falling", () => {
    const withMask = layeredForecast(baseInput({ history, stockoutDates: stockouts }));
    const withoutMask = layeredForecast(baseInput({ history }));
    expect(withMask.finalForecast30d).toBeGreaterThan(withoutMask.finalForecast30d * 2);
  });

  it("the corrected rate shortens days-until-stockout accordingly", () => {
    const withMask = layeredForecast(baseInput({ history, stockoutDates: stockouts, currentStock: 10 }));
    const withoutMask = layeredForecast(baseInput({ history, currentStock: 10 }));
    expect(withMask.daysUntilStockout).toBeLessThan(withoutMask.daysUntilStockout);
  });
});

describe("promo lift (layer 2)", () => {
  it("an owner-entered matching promo lifts the forecast and stamps a signal", () => {
    const promo = { discountPct: 20, promoType: "discount", channel: "online", scope: "all", scopeValue: null };
    const withPromo = layeredForecast(baseInput({ history: steady(90), activePromos: [promo] }));
    const without = layeredForecast(baseInput({ history: steady(90) }));
    // 20% discount × 1.5 elasticity = +30%
    expect(withPromo.finalForecast30d).toBeCloseTo(without.finalForecast30d * 1.3, 6);
    expect(withPromo.signals.some((s) => s.emoji === "🏷️")).toBe(true);
    expect(withPromo.layer2Adjustment).toBeGreaterThan(0);
  });

  it("a non-matching promo does nothing", () => {
    const promo = { discountPct: 50, promoType: "discount", channel: "online", scope: "sku", scopeValue: "OTHER" };
    const r = layeredForecast(baseInput({ history: steady(90), activePromos: [promo] }));
    expect(r.layer2Adjustment).toBe(0);
    expect(r.signals).toHaveLength(0);
  });
});

describe("best-month cap", () => {
  it("caps at capMultiple × best trailing month and stamps a signal", () => {
    // capMultiple 0.5 forces the cap below the run-rate forecast.
    const r = layeredForecast(baseInput({ history: steady(90), capMultiple: 0.5 }));
    expect(r.signals.some((s) => s.emoji === "✂️")).toBe(true);
    expect(r.layer2Adjustment).toBeLessThan(0);
    const noCap = layeredForecast(baseInput({ history: steady(90) }));
    expect(r.finalForecast30d).toBeLessThan(noCap.finalForecast30d);
  });

  it("the default cap is generous — a steady seller is never capped", () => {
    const r = layeredForecast(baseInput({ history: steady(90) }));
    expect(r.signals.some((s) => s.emoji === "✂️")).toBe(false);
  });
});

describe("service-level knobs", () => {
  it("per-class z override scales safety stock", () => {
    const base = layeredForecast(baseInput({ history: steady(90), abcCategory: "A" }));
    const boosted = layeredForecast(
      baseInput({ history: steady(90), abcCategory: "A", serviceZ: { A: 4.66 } })
    );
    expect(boosted.safetyStock).toBeCloseTo(base.safetyStock * 2, 4);
    expect(boosted.reorderPoint).toBeGreaterThan(base.reorderPoint);
  });
});

describe("determinism", () => {
  it("two runs with the same runDateKey produce identical output", () => {
    const input = baseInput({ history: steady(45) });
    expect(layeredForecast(input)).toEqual(layeredForecast(input));
  });
});
