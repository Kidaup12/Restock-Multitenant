import { describe, it, expect } from "vitest";
import {
  guardrailCap,
  guardForecastResult,
  GUARDRAIL_MULTIPLIER,
  THIN_DATA_ABSOLUTE_CAP_30D,
} from "../src/guardrail";
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
    confidenceWord: "fairly_sure",
    confidenceSignals: {
      historyDays: 200,
      cv: 0.3,
      stockoutGapShare: 0,
      promoContaminated: false,
      coldStart: false,
    },
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

  it("thin history (<30d): caps at the thin-data ceiling, not uncapped", () => {
    // Was uncapped; now a cold-start 40 on a 2-seller is held to max(3×2, 12) = 12.
    const d = guardrailCap({ finalForecast30d: 40, sold30: 2, historySpanDays: 10, currentStock: 5 });
    expect(d).toEqual({ finalForecast30d: THIN_DATA_ABSOLUTE_CAP_30D, capped: true });
  });

  it("thin history: 3× recent sales wins when it exceeds the ceiling", () => {
    // sold 8 in a short window → 3×8 = 24 > 12, so a real breakout keeps its room.
    const d = guardrailCap({ finalForecast30d: 40, sold30: 8, historySpanDays: 10, currentStock: 5 });
    expect(d).toEqual({ finalForecast30d: 24, capped: true });
  });

  it("thin history: a forecast already under the ceiling is left alone", () => {
    const d = guardrailCap({ finalForecast30d: 9, sold30: 1, historySpanDays: 10, currentStock: 5 });
    expect(d.capped).toBe(false);
    expect(d.finalForecast30d).toBe(9);
  });

  it("in stock + zero sales → token cap, not a big buy", () => {
    const d = guardrailCap({ finalForecast30d: 46, sold30: 0, historySpanDays: 300, currentStock: 4 });
    expect(d).toEqual({ finalForecast30d: 3, capped: true });
  });

  it("OUT of stock + zero sales: censored, but held to the thin-data ceiling (not fantasy)", () => {
    const d = guardrailCap({ finalForecast30d: 46, sold30: 0, historySpanDays: 300, currentStock: 0 });
    expect(d).toEqual({ finalForecast30d: THIN_DATA_ABSOLUTE_CAP_30D, capped: true });
  });

  it("heavily censored (out >7 of 30): capped at max(3×sold, ceiling), not uncapped", () => {
    // sold 10 despite being out 12 days → 3×10 = 30 > 12, so cap at 30.
    const d = guardrailCap({ finalForecast30d: 60, sold30: 10, historySpanDays: 300, currentStock: 2, stockoutDays30: 12 });
    expect(d).toEqual({ finalForecast30d: 30, capped: true });
  });

  it("still caps a full-shelf item at 3× recent sales", () => {
    const d = guardrailCap({ finalForecast30d: 60, sold30: 10, historySpanDays: 300, currentStock: 2, stockoutDays30: 0 });
    expect(d).toEqual({ finalForecast30d: 30, capped: true });
  });

  it("does not clip a legitimately floored Class-A item below its floor (12/30d)", () => {
    // A starved bestseller floored to 0.4/day → 12/30d; a thin window must not
    // cut it below that (max(3×sold, 12) === 12 here).
    const d = guardrailCap({ finalForecast30d: 12, sold30: 0, historySpanDays: 10, currentStock: 0 });
    expect(d.finalForecast30d).toBe(THIN_DATA_ABSOLUTE_CAP_30D);
    expect(d.capped).toBe(false);
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

  it("a heavily censored window is held to max(3×recent sales, ceiling)", () => {
    // sold 10 recently despite being out 12 days → cap at 3×10 = 30 (> ceiling 12),
    // instead of the old uncapped 60.
    const history = [
      { date: day(400), quantity: 5 },
      { date: day(5), quantity: 10 },
    ];
    const stockoutDates = Array.from({ length: 12 }, (_, i) => day(i + 10));
    const r = guardForecastResult(baseResult(60), { history, currentStock: 2, today: day(0), stockoutDates });
    expect(r.finalForecast30d).toBe(30);
    expect(r.signals.some((s) => s.emoji === "🛡️")).toBe(true);
  });

  it("multiplier stays generous enough for real spikes (3×)", () => {
    expect(GUARDRAIL_MULTIPLIER).toBe(3);
  });
});
