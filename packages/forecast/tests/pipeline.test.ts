import { describe, it, expect } from "vitest";
import { forecastProduct, type ProductForecastInput } from "../src/pipeline";
import { methodToPolicy } from "../src/config";

const RUN_KEY = "2026-07-21";
const TODAY = new Date(`${RUN_KEY}T00:00:00Z`);
const day = (daysAgo: number) => new Date(+TODAY - daysAgo * 864e5);

const steady = (days: number, qty = 2) =>
  Array.from({ length: days }, (_, i) => ({ date: day(i + 1), quantity: qty }));

function baseInput(overrides: Partial<ProductForecastInput> = {}): ProductForecastInput {
  return {
    productId: "p1",
    product: { sku: "SKU-1", productType: "SERUM", vendor: "ACME", currentStock: 5, onOrder: 0 },
    supplier: { leadTimeAvgDays: 14, leadTimeStdDays: 3 },
    history: steady(90),
    abcCategory: "A",
    runDateKey: RUN_KEY,
    ...overrides,
  };
}

describe("forecastProduct", () => {
  it("produces the full Prediction field set for a healthy seller", () => {
    const p = forecastProduct(baseInput({ policy: methodToPolicy("stay_in_stock") }));
    expect(p.finalForecast30d).toBeGreaterThan(0);
    expect(p.recommendedQty).toBeGreaterThan(0);
    expect(p.safetyStock).toBeGreaterThan(0);
    expect(p.reorderPoint).toBeGreaterThan(0);
    expect(p.daysUntilStockout).toBeLessThan(30);
    expect(p.urgency).toBe("critical"); // ~1.7/day against 5 in stock
    expect(p.regime).toBe("forecast");
    expect(p.confidence).toBeGreaterThan(0);
    expect(typeof p.reasoning).toBe("string");
    expect(Array.isArray(p.signals)).toBe(true);
  });

  it("a dead listing under a min/max policy is NOT topped up to the par floor", () => {
    // One sale 400 days ago, zero stock: the par rule's 1-unit floor must not
    // turn a dead product into a standing 1-unit recommendation.
    const p = forecastProduct(
      baseInput({
        history: [{ date: day(400), quantity: 1 }],
        product: { sku: "SKU-1", currentStock: 0, onOrder: 0 },
        abcCategory: "C",
        policy: methodToPolicy("lean_cash"),
      })
    );
    expect(p.finalForecast30d).toBe(0);
    expect(p.recommendedQty).toBe(0);
    expect(p.urgency).toBe("low");
    expect(p.regime).toBe("min_max");
  });

  it("a slow-but-alive C item under min/max gets a par top-up", () => {
    const p = forecastProduct(
      baseInput({
        history: steady(90, 1),
        product: { sku: "SKU-1", currentStock: 0, onOrder: 0 },
        supplier: null,
        abcCategory: "C",
        policy: methodToPolicy("lean_cash"),
      })
    );
    expect(p.recommendedQty).toBeGreaterThan(0);
    expect(p.regime).toBe("min_max");
  });

  it("stock already in transit suppresses the recommendation", () => {
    const withOnOrder = forecastProduct(
      baseInput({ product: { sku: "SKU-1", currentStock: 5, onOrder: 500 } })
    );
    expect(withOnOrder.recommendedQty).toBe(0);
  });

  it("a brand-new product is honestly 'too new', never a buy recommendation", () => {
    const p = forecastProduct(
      baseInput({ history: [], product: { sku: "SKU-1", currentStock: 0, onOrder: 0 } })
    );
    expect(p.recommendedQty).toBe(0);
    expect(p.urgency).toBe("low");
    expect(p.reasoning).toContain("too new to forecast");
    expect(p.signals.some((s) => s.label.includes("no sales history"))).toBe(true);
  });

  it("proven stockout days raise the recommendation instead of reading as falling demand", () => {
    const history = [{ date: day(400), quantity: 1 }, ...steady(10)];
    const stockouts = Array.from({ length: 20 }, (_, i) => day(i + 11));
    const masked = forecastProduct(baseInput({ history, stockoutDates: stockouts, abcCategory: "B" }));
    const unmasked = forecastProduct(baseInput({ history, abcCategory: "B" }));
    expect(masked.finalForecast30d).toBeGreaterThan(unmasked.finalForecast30d * 2);
    expect(masked.recommendedQty).toBeGreaterThan(unmasked.recommendedQty);
  });

  it("a real supplier lead time widens the order cover (mean-cover rule)", () => {
    const withLead = forecastProduct(baseInput({ abcCategory: "B", supplier: { leadTimeAvgDays: 14 } }));
    const noLead = forecastProduct(baseInput({ abcCategory: "B", supplier: null }));
    expect(withLead.recommendedQty).toBeGreaterThan(noLead.recommendedQty);
  });
});
