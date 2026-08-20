import { describe, expect, it } from "vitest";
import { layeredForecast, type ForecastInput } from "../src/layered";
import { resolveForecastKnobs } from "../src/config";
import type { SalesPoint } from "../src/baseline";

/**
 * Invariants the engine must hold for ANY input the database can hand it.
 *
 * The buy list turns these numbers into money a shop spends, so a NaN, an
 * Infinity or a negative quantity is not a cosmetic defect — it is either a
 * blank cell where a decision should be, or an order for nonsense. Real
 * catalogues carry every shape below: a zero price on an unpriced SKU, negative
 * stock from an oversell, a single sale two years ago, a product that sells
 * thousands a day.
 *
 * These assert properties rather than fixed outputs, so they keep holding as the
 * sizing changes.
 */

const DAY = 86_400_000;
const ANCHOR = Date.UTC(2026, 7, 20);

function history(spec: { daysAgo: number; quantity: number }[]): SalesPoint[] {
  return spec.map((s) => ({
    date: new Date(ANCHOR - s.daysAgo * DAY),
    quantity: s.quantity,
    revenueKes: s.quantity * 100,
  }));
}

function input(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    productId: "p-1",
    productType: "Skincare",
    vendor: "Acme",
    sku: "SKU-1",
    currentStock: 10,
    abcCategory: "B",
    history: history([
      { daysAgo: 1, quantity: 2 },
      { daysAgo: 5, quantity: 3 },
      { daysAgo: 20, quantity: 1 },
    ]),
    leadTimeAvg: 7,
    leadTimeStd: 2,
    activePromos: [],
    runDateKey: "2026-08-20",
    ...over,
  };
}

/** Every number the engine returns, flattened, with its path. */
function numbersIn(result: unknown, path = ""): [string, number][] {
  if (typeof result === "number") return [[path, result]];
  if (Array.isArray(result)) return result.flatMap((v, i) => numbersIn(v, `${path}[${i}]`));
  if (result && typeof result === "object") {
    return Object.entries(result).flatMap(([k, v]) => numbersIn(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/** The shapes a real catalogue actually contains. */
const CASES: [string, Partial<ForecastInput>][] = [
  ["no history at all", { history: [] }],
  ["one sale, today", { history: history([{ daysAgo: 0, quantity: 1 }]) }],
  ["one sale, two years ago", { history: history([{ daysAgo: 730, quantity: 1 }]) }],
  ["negative stock (oversold)", { currentStock: -14 }],
  ["zero stock", { currentStock: 0 }],
  ["enormous stock", { currentStock: 1_000_000 }],
  ["fractional stock", { currentStock: 3.7 }],
  ["zero lead time", { leadTimeAvg: 0, leadTimeStd: 0 }],
  ["huge lead time", { leadTimeAvg: 365, leadTimeStd: 90 }],
  ["negative lead std", { leadTimeAvg: 7, leadTimeStd: -3 }],
  ["a single enormous sale", { history: history([{ daysAgo: 3, quantity: 9999 }]) }],
  ["zero-quantity rows only", { history: history([{ daysAgo: 1, quantity: 0 }, { daysAgo: 2, quantity: 0 }]) }],
  ["negative quantity (a return)", { history: history([{ daysAgo: 1, quantity: -5 }, { daysAgo: 2, quantity: 3 }]) }],
  ["fractional quantities", { history: history([{ daysAgo: 1, quantity: 0.4 }, { daysAgo: 2, quantity: 0.1 }]) }],
  ["no ABC class", { abcCategory: null }],
  ["unknown ABC class", { abcCategory: "Z" }],
  ["null product type and vendor", { productType: null, vendor: null }],
  ["empty sku", { sku: "" }],
  ["future-dated sale", { history: history([{ daysAgo: -30, quantity: 5 }]) }],
  ["every day excluded", {
    history: history([{ daysAgo: 1, quantity: 2 }, { daysAgo: 2, quantity: 2 }]),
    excludedDates: [new Date(ANCHOR - DAY), new Date(ANCHOR - 2 * DAY)],
  }],
  ["every day a proven stockout", {
    history: history([{ daysAgo: 1, quantity: 2 }, { daysAgo: 2, quantity: 2 }]),
    stockoutDates: [new Date(ANCHOR - DAY), new Date(ANCHOR - 2 * DAY)],
    snapshotsSince: new Date(ANCHOR - 30 * DAY),
  }],
  ["z override of zero", { serviceZ: { B: 0 } }],
  ["negative z override", { serviceZ: { B: -2 } }],
  ["cap multiple of zero", { capMultiple: 0 }],
  ["1000 days of history", {
    history: history(Array.from({ length: 1000 }, (_, i) => ({ daysAgo: i, quantity: i % 5 }))),
  }],
];

describe("the engine returns usable numbers for anything the catalogue holds", () => {
  for (const [name, over] of CASES) {
    it(name, () => {
      const result = layeredForecast(input(over));

      for (const [path, value] of numbersIn(result)) {
        expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
      }

      // A shop cannot order a negative quantity, and a negative forecast is a
      // number no screen has copy for.
      expect(result.finalForecast30d, "finalForecast30d").toBeGreaterThanOrEqual(0);
      expect(result.recommendedQty, "recommendedQty").toBeGreaterThanOrEqual(0);
      expect(result.safetyStock, "safetyStock").toBeGreaterThanOrEqual(0);
      expect(result.reorderPoint, "reorderPoint").toBeGreaterThanOrEqual(0);

      // Whole units — nobody ships 4.7 bottles.
      expect(Number.isInteger(result.recommendedQty), `recommendedQty ${result.recommendedQty}`).toBe(true);

      // The sentence is rendered verbatim next to the number.
      for (const bad of ["NaN", "Infinity", "undefined", "null", "[object"]) {
        expect(result.reasoning, `reasoning contains ${bad}`).not.toContain(bad);
      }
      expect(result.reasoning.length).toBeGreaterThan(0);
    });
  }

  it("is deterministic — the same input twice gives the same answer", () => {
    // The nightly run and the screen both size from this; two answers for one
    // product is a number nobody can reconcile.
    const once = layeredForecast(input());
    const twice = layeredForecast(input());
    expect(once).toEqual(twice);
  });

  it("never recommends ordering when the shelf already covers the horizon", () => {
    const result = layeredForecast(input({ currentStock: 100_000 }));
    expect(result.recommendedQty).toBe(0);
  });
});

/**
 * The stored knobs are nullable Floats with no database constraint, and they are
 * deliberately not on the settings screen — but the operator console, a support
 * fix or a later settings screen can all put a value in the column, and it went
 * to the engine exactly as stored.
 */
describe("stored forecast knobs are bounded before they reach the engine", () => {
  it("keeps a negative service level from inverting the safety buffer", () => {
    // A z of -2 produced a safety stock of -4.5 units, which LOWERS the reorder
    // point — the opposite of a safety margin, and an order placed too late.
    const knobs = resolveForecastKnobs({ serviceLevelZB: -2 });
    expect(knobs.serviceZ.B).toBeGreaterThan(0);
    const result = layeredForecast(input({ serviceZ: knobs.serviceZ }));
    expect(result.safetyStock).toBeGreaterThanOrEqual(0);
  });

  it("keeps a zero cap multiple from silently emptying the buy list", () => {
    // cap x best month = 0 clamps every forecast in the shop to nothing.
    expect(resolveForecastKnobs({ orderCapMultiple: 0 }).capMultiple).toBeGreaterThanOrEqual(1);
  });

  it("falls back to the default for a value that is not a number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      const knobs = resolveForecastKnobs({ serviceLevelZA: bad as number | null });
      expect(Number.isFinite(knobs.serviceZ.A), String(bad)).toBe(true);
      expect(knobs.serviceZ.A).toBeGreaterThan(0);
    }
  });

  it("leaves a sensible stored value exactly as the shop set it", () => {
    // Clamping must not quietly rewrite a legitimate override.
    expect(resolveForecastKnobs({ serviceLevelZA: 1.9 }).serviceZ.A).toBe(1.9);
    expect(resolveForecastKnobs({ orderCapMultiple: 4 }).capMultiple).toBe(4);
  });

  it("uses the documented defaults when nothing is stored", () => {
    const knobs = resolveForecastKnobs(null);
    expect(knobs.serviceZ.A).toBe(2.33);
    expect(knobs.serviceZ.B).toBe(1.65);
    expect(knobs.serviceZ.C).toBe(1.28);
  });

  it("floors the buffer even if a caller bypasses the boundary entirely", () => {
    // The engine does not rely on resolveForecastKnobs having been called.
    const result = layeredForecast(input({ serviceZ: { B: -5 } }));
    expect(result.safetyStock).toBeGreaterThanOrEqual(0);
    expect(result.reorderPoint).toBeGreaterThanOrEqual(0);
  });
});
