import { describe, it, expect } from "vitest";
import { assembleForecastResult, type DemandForecast } from "../src/assemble";
import { runRateDaily, type ForecastInput } from "../src/layered";
import {
  kingsSafetyStock,
  reorderPoint,
  standardDeviation,
  zForServiceLevel,
  urgencyFromDays,
  daysOfStockRemaining,
} from "../src/baseline";

// Fixed run day so every date computation is deterministic.
const RUN_KEY = "2026-06-05";
const today = new Date(`${RUN_KEY}T00:00:00Z`);

const history = Array.from({ length: 90 }, (_, i) => {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - (90 - i));
  return { date: d, quantity: 4 + (i % 3) }; // ~4-6 units/day, deterministic
});

const input: ForecastInput = {
  productId: "prod-test-001",
  productType: "SERUM",
  vendor: "Olay",
  sku: "SKU-001",
  currentStock: 30,
  abcCategory: "A",
  history,
  leadTimeAvg: 30,
  leadTimeStd: 7,
  activePromos: [],
  runDateKey: RUN_KEY,
};

const demand: DemandForecast = {
  layer1Forecast30d: 100,
  layer1Confidence: 0.75,
  layer2Adjustment: 20,
  finalForecast30d: 120,
  confidence: 0.8,
  reasoning: "External regime. Calendar layer added 20% for a demand peak.",
  signals: [{ label: "Demand peak +12%", deltaPct: 12, emoji: "💰" }],
  regime: "external",
};

/** The same rate/std the assembler derives, computed independently. */
function expectedParts() {
  const dailyRate = runRateDaily(history, today);
  const last90 = new Date(today);
  last90.setUTCDate(last90.getUTCDate() - 90);
  const demandStd = standardDeviation(history.filter((p) => p.date >= last90).map((p) => p.quantity));
  return { dailyRate, demandStd };
}

describe("assembleForecastResult", () => {
  it("returns layer fields from demand unchanged", () => {
    const result = assembleForecastResult(input, demand);
    expect(result.layer1Forecast30d).toBe(100);
    expect(result.layer1Confidence).toBe(0.75);
    expect(result.layer2Adjustment).toBe(20);
    expect(result.finalForecast30d).toBe(120);
    expect(result.confidence).toBe(0.8);
    expect(result.reasoning).toBe(demand.reasoning);
    expect(result.signals).toEqual(demand.signals);
  });

  it("safetyStock > 0 for A-class product with variance", () => {
    const result = assembleForecastResult(input, demand);
    expect(result.safetyStock).toBeGreaterThan(0);
  });

  it("safetyStock matches the King's-formula primitives exactly", () => {
    const result = assembleForecastResult(input, demand);
    const { dailyRate, demandStd } = expectedParts();
    const expected = kingsSafetyStock({
      z: zForServiceLevel("A"),
      leadTimeAvg: 30,
      leadTimeStd: 7,
      demandAvg: dailyRate,
      demandStd,
    });
    expect(result.safetyStock).toBeCloseTo(expected, 6);
  });

  it("reorderPoint matches the primitives exactly", () => {
    const result = assembleForecastResult(input, demand);
    const { dailyRate, demandStd } = expectedParts();
    const safety = kingsSafetyStock({
      z: zForServiceLevel("A"),
      leadTimeAvg: 30,
      leadTimeStd: 7,
      demandAvg: dailyRate,
      demandStd,
    });
    expect(result.reorderPoint).toBeCloseTo(reorderPoint(dailyRate, 30, safety), 6);
  });

  it("recommendedQty > 0 when demand exceeds stock", () => {
    const result = assembleForecastResult(input, demand);
    expect(result.recommendedQty).toBeGreaterThan(0);
  });

  it("recommendedQty = max(0, ceil(finalForecast30d + safetyStock - currentStock))", () => {
    const result = assembleForecastResult(input, demand);
    const expected = Math.max(0, Math.ceil(120 + result.safetyStock - 30));
    expect(result.recommendedQty).toBe(expected);
  });

  it("recommendedQty is 0 when stock is already ample", () => {
    const ampleInput: ForecastInput = { ...input, currentStock: 9999 };
    const result = assembleForecastResult(ampleInput, demand);
    expect(result.recommendedQty).toBe(0);
  });

  it("daysUntilStockout matches daysOfStockRemaining on the same rate", () => {
    const result = assembleForecastResult(input, demand);
    const { dailyRate } = expectedParts();
    const fallbackRate = dailyRate > 0 ? dailyRate : 120 / 30;
    expect(result.daysUntilStockout).toBe(daysOfStockRemaining(30, fallbackRate));
  });

  it("urgency is consistent with daysUntilStockout and the rate gate", () => {
    const result = assembleForecastResult(input, demand);
    const { dailyRate } = expectedParts();
    expect(result.urgency).toBe(urgencyFromDays(result.daysUntilStockout, dailyRate));
  });

  it("urgency is critical when stock is near zero", () => {
    const emptyInput: ForecastInput = { ...input, currentStock: 1, history: [] };
    const result = assembleForecastResult(emptyInput, { ...demand, finalForecast30d: 120 });
    // no history → rate falls back to 120/30 = 4/day; daysLeft = floor(1/4) = 0 → critical
    expect(result.urgency).toBe("critical");
  });

  it("exposes demandStd so the calibrated reorder path works behind an external engine", () => {
    const result = assembleForecastResult(input, demand);
    const { demandStd } = expectedParts();
    expect(result.demandStd).toBeCloseTo(demandStd, 6);
  });

  it("applies the tenant z override like the built-in engine", () => {
    const base = assembleForecastResult(input, demand);
    const overridden = assembleForecastResult({ ...input, serviceZ: { A: 4.66 } }, demand);
    expect(overridden.safetyStock).toBeCloseTo(base.safetyStock * 2, 4);
  });
});
