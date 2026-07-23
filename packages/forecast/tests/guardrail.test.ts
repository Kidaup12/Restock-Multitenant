import { describe, it, expect } from "vitest";
import { guardrailCap, guardForecastResult, GUARDRAIL_MULTIPLIER } from "../src/guardrail";
import type { ForecastResult } from "../src/layered";

const day = (daysAgo: number, today = new Date("2026-07-21T00:00:00Z")) =>
  new Date(+today - daysAgo * 864e5);

function baseResult(f30: number): ForecastResult {
  return {
    layer1Forecast30d: f30,
    layer1Confidence: 0.7,
    layer2Adjustment: 1,
    finalForecast30d: f30,
    daysUntilStockout: 1,
    recommendedQty: 0,
    safetyStock: 6,
    reorderPoint: 10,
    confidence: 0.7,
    reasoning: "",
    urgency: "high",
    signals: [],
    demandStd: 2,
  };
}

describe("guardrailCap", () => {
  it("caps a forecast above 3× recent sales", () => {
    // Sold 10 in 30d, engine says 51 → cap at 30.
    const d = guardrailCap({ finalForecast30d: 51, sold30: 10, historySpanDays: 200, currentStock: 1 });
    expect(d).toEqual({ finalForecast30d: 30, capped: true });
  });

  it("leaves a sane forecast alone", () => {
    const d = guardrailCap({ finalForecast30d: 25, sold30: 10, historySpanDays: 200, currentStock: 1 });
    expect(d.capped).toBe(false);
    expect(d.finalForecast30d).toBe(25);
  });

  it("never clamps items younger than 30 days — cold-start estimates are all we have", () => {
    const d = guardrailCap({ finalForecast30d: 40, sold30: 2, historySpanDays: 10, currentStock: 5 });
    expect(d.capped).toBe(false);
  });

  it("in stock + zero sales → token cap, not a big buy", () => {
    const d = guardrailCap({ finalForecast30d: 46, sold30: 0, historySpanDays: 300, currentStock: 4 });
    expect(d).toEqual({ finalForecast30d: 3, capped: true });
  });

  it("OUT of stock + zero sales is censored demand — never clamped", () => {
    const d = guardrailCap({ finalForecast30d: 46, sold30: 0, historySpanDays: 300, currentStock: 0 });
    expect(d.capped).toBe(false);
  });

  it("skips the cap when the item was out >7 of the last 30 days", () => {
    const d = guardrailCap({ finalForecast30d: 60, sold30: 10, historySpanDays: 300, currentStock: 2, stockoutDays30: 12 });
    expect(d.capped).toBe(false); // sold30 understates true demand — not a fair cap
  });

  it("still caps when the shelf was full all month", () => {
    const d = guardrailCap({ finalForecast30d: 60, sold30: 10, historySpanDays: 300, currentStock: 2, stockoutDays30: 0 });
    expect(d).toEqual({ finalForecast30d: 30, capped: true });
  });
});

describe("guardForecastResult", () => {
  it("scales demand-derived fields and stamps a visible signal", () => {
    const history = [
      { date: day(400), quantity: 5 }, // old point → 400d span
      { date: day(20), quantity: 6 },
      { date: day(5), quantity: 4 },
    ]; // sold30 = 10
    const r = guardForecastResult(baseResult(51), { history, currentStock: 9, today: day(0) });
    expect(r.finalForecast30d).toBe(30);
    const ratio = 30 / 51;
    expect(r.safetyStock).toBeCloseTo(6 * ratio, 6);
    expect(r.demandStd).toBeCloseTo(2 * ratio, 6);
    expect(r.daysUntilStockout).toBe(Math.floor(9 / 1)); // 30/30 = 1/day
    expect(r.signals.some((s) => s.emoji === "🛡️")).toBe(true);
  });

  it("returns the result untouched when within bounds", () => {
    const history = [{ date: day(200), quantity: 30 }, { date: day(10), quantity: 12 }];
    const r = guardForecastResult(baseResult(30), { history, currentStock: 9, today: day(0) });
    expect(r.finalForecast30d).toBe(30);
    expect(r.signals).toHaveLength(0);
  });

  it("a heavily censored window passes through uncapped", () => {
    const history = [
      { date: day(400), quantity: 5 },
      { date: day(5), quantity: 10 },
    ];
    const stockoutDates = Array.from({ length: 12 }, (_, i) => day(i + 10));
    const r = guardForecastResult(baseResult(60), { history, currentStock: 2, today: day(0), stockoutDates });
    expect(r.finalForecast30d).toBe(60);
  });

  it("multiplier stays generous enough for real spikes (3×)", () => {
    expect(GUARDRAIL_MULTIPLIER).toBe(3);
  });
});
