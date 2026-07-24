import { describe, it, expect } from "vitest";
import { layeredForecast, type ForecastInput } from "../src/layered";
import { forecastProduct, type ProductForecastInput } from "../src/pipeline";
import type { SalesPoint } from "../src/baseline";

const RUN = "2026-07-24";
const DAY = 86_400_000;
const base = new Date("2026-07-24T00:00:00Z");
const at = (daysAgo: number, quantity: number): SalesPoint => ({
  date: new Date(base.getTime() - daysAgo * DAY),
  quantity,
});
function steady(days = 120, rate = 3): SalesPoint[] {
  const out: SalesPoint[] = [];
  for (let d = days; d >= 0; d--) out.push(at(d, rate));
  return out;
}

const input = (over: Partial<ForecastInput>): ForecastInput => ({
  productId: "p",
  productType: "Hair Care",
  vendor: "Cantu",
  sku: "SKU-1",
  currentStock: 5,
  abcCategory: "B",
  history: [],
  leadTimeAvg: 10,
  leadTimeStd: 3,
  activePromos: [],
  runDateKey: RUN,
  ...over,
});

describe("layeredForecast — confidence word", () => {
  it("emits a confidence word and its signals on every result", () => {
    const r = layeredForecast(input({ history: steady(120, 3) }));
    expect(["sure", "fairly_sure", "guessing"]).toContain(r.confidenceWord);
    expect(r.confidenceSignals.historyDays).toBeGreaterThan(100);
  });

  it("a product with no history is a guess and recommends nothing (too new, never zero-silent)", () => {
    const r = layeredForecast(input({ history: [] }));
    expect(r.confidenceWord).toBe("guessing");
    expect(r.confidenceSignals.coldStart).toBe(true);
    expect(r.recommendedQty).toBe(0);
    expect(r.reasoning).toMatch(/too new/i);
    expect(r.signals.some((s) => /no sales history/i.test(s.label))).toBe(true);
  });
});

describe("layeredForecast — demand override", () => {
  it("a borrowed override forecasts against the borrowed rate, flagged as a guess", () => {
    const r = layeredForecast(
      input({
        history: [],
        currentStock: 0,
        demandOverride: { forecast30d: 90, source: "borrowed", label: "Borrowed from Cantu Shea Butter" },
      })
    );
    expect(r.finalForecast30d).toBe(90);
    expect(r.confidenceWord).toBe("guessing");
    expect(r.recommendedQty).toBeGreaterThan(0); // not silently zero
    expect(r.signals.some((s) => /borrowed/i.test(s.label))).toBe(true);
    expect(r.reasoning).toMatch(/borrowing/i);
  });

  it("an owner-prior override never reads as 'sure' even on a long, clean history", () => {
    const r = layeredForecast(
      input({
        history: steady(150, 3),
        demandOverride: { forecast30d: 200, source: "owner_prior", label: "Owner expects ~200/mo" },
      })
    );
    expect(r.finalForecast30d).toBe(200); // owner figure is not capped
    expect(r.confidenceWord).not.toBe("sure");
    expect(r.signals.some((s) => /owner/i.test(s.label))).toBe(true);
  });

  it("skips the runaway cap for an owner override the engine would otherwise clip", () => {
    // best trailing month here is ~90 (30d * 3); 3x cap = 270. Owner says 500.
    const r = layeredForecast(
      input({
        history: steady(120, 3),
        demandOverride: { forecast30d: 500, source: "owner_prior", label: "Owner expects ~500/mo" },
      })
    );
    expect(r.finalForecast30d).toBe(500);
  });
});

describe("forecastProduct — persisted trust fields", () => {
  const productInput = (over: Partial<ProductForecastInput>): ProductForecastInput => ({
    productId: "p",
    product: {
      sku: "SKU-1",
      productType: "Hair Care",
      vendor: "Cantu",
      currentStock: 5,
      onOrder: 0,
      leadTimeDays: 10,
      priceKes: 1000,
      costKes: 600,
    },
    supplier: { leadTimeAvgDays: 10, leadTimeStdDays: 3 },
    history: steady(120, 3),
    abcCategory: "B",
    runDateKey: RUN,
    ...over,
  });

  it("returns a confidence word and an explain breakdown that sums to the quantity", () => {
    const fields = forecastProduct(productInput({ product: { sku: "SKU-1", currentStock: 0, onOrder: 0, leadTimeDays: 10, priceKes: 1000, costKes: 600, vendor: "Cantu", productType: "Hair Care" } }));
    expect(["sure", "fairly_sure", "guessing"]).toContain(fields.confidenceWord);
    // The persisted breakdown's total is exactly the recommended quantity.
    expect(fields.explainParts.recommendedQty).toBe(fields.recommendedQty);
    expect(fields.explainParts.summary).toContain(`= ${fields.recommendedQty}`);
  });

  it("threads a borrowed override through the one engine (consistent qty + explain)", () => {
    const fields = forecastProduct(
      productInput({
        history: [],
        product: { sku: "NEW", currentStock: 0, onOrder: 0, leadTimeDays: 10, priceKes: 1000, costKes: 600, vendor: "Cantu", productType: "Hair Care" },
        demandOverride: { forecast30d: 90, source: "borrowed", label: "Borrowed from Cantu Shea Butter" },
      })
    );
    expect(fields.confidenceWord).toBe("guessing");
    expect(fields.recommendedQty).toBeGreaterThan(0);
    expect(fields.explainParts.recommendedQty).toBe(fields.recommendedQty);
  });
});
