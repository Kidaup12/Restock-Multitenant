import { describe, expect, it } from "vitest";
import { assignAbc, dailySalesValue, type SalesPoint } from "@wezesha/forecast";
import {
  abcForCatalogue,
  coverDays,
  moneyAtRest,
  revenueByWindow,
  revenueForWindow,
  runRate,
} from "@/lib/metrics";

/**
 * Pure metric-contract unit tests — no database. Each metric is exercised
 * against hand-built inputs so the shared formula is pinned independently of any
 * screen. The math itself lives in @wezesha/forecast (covered there); these
 * assert the metric layer wires it correctly and applies its display rules.
 */

const ASOF = new Date("2026-07-24T00:00:00.000Z");
const DAY_MS = 86_400_000;

/** One sale of `qty` (revenue qty*price) on each of the last `days` days. */
function dailyHistory(days: number, qty: number, price: number): SalesPoint[] {
  const out: SalesPoint[] = [];
  for (let i = 1; i <= days; i++) {
    out.push({ date: new Date(ASOF.getTime() - i * DAY_MS), quantity: qty, revenueKes: qty * price });
  }
  return out;
}

describe("runRate — blended all-channel engine rate", () => {
  it("is 0 for no history", () => {
    expect(runRate([], ASOF)).toBe(0);
  });

  it("blends the 30/90/365 windows to the steady rate", () => {
    // 1 unit/day every day → each window rate is 1.0 → 0.5+0.3+0.2 = 1.0.
    expect(runRate(dailyHistory(365, 1, 100), ASOF)).toBeCloseTo(1.0, 6);
  });

  it("weights recent sales more heavily than old ones", () => {
    // 2/day every day across a full-year span → the blend lands on 2.0.
    const steady = runRate(dailyHistory(365, 2, 100), ASOF);
    // Same 2/day, but only in the last 30 days of a 365-day span → the empty
    // 90/365 windows dilute the blend below the flat 30-day average.
    const concentrated = runRate(
      Array.from({ length: 365 }, (_, k) => {
        const i = k + 1;
        const qty = i <= 30 ? 2 : 0;
        return { date: new Date(ASOF.getTime() - i * DAY_MS), quantity: qty, revenueKes: qty * 100 };
      }),
      ASOF
    );
    expect(steady).toBeCloseTo(2.0, 6);
    expect(concentrated).toBeGreaterThan(0);
    expect(concentrated).toBeLessThan(steady);
  });
});

describe("coverDays — one formula, live from current stock", () => {
  it("is stock ÷ run rate, floored", () => {
    expect(coverDays(100, 5)).toBe(20);
    expect(coverDays(97, 5)).toBe(19); // floored
  });

  it("returns the 999 sentinel at (near) zero run rate", () => {
    expect(coverDays(50, 0)).toBe(999);
  });
});

describe("revenue windows — all channels", () => {
  const history: SalesPoint[] = [
    { date: new Date(ASOF.getTime() - 10 * DAY_MS), quantity: 1, revenueKes: 100 },
    { date: new Date(ASOF.getTime() - 40 * DAY_MS), quantity: 1, revenueKes: 200 },
    { date: new Date(ASOF.getTime() - 200 * DAY_MS), quantity: 1, revenueKes: 300 },
    { date: new Date(ASOF.getTime() - 400 * DAY_MS), quantity: 1, revenueKes: 400 },
  ];

  it("sums revenue inside each window", () => {
    expect(revenueForWindow(history, 30, ASOF)).toBe(100);
    expect(revenueForWindow(history, 90, ASOF)).toBe(300);
    expect(revenueForWindow(history, 365, ASOF)).toBe(600);
  });

  it("revenueByWindow returns all three at once", () => {
    expect(revenueByWindow(history, ASOF)).toEqual({ 30: 100, 90: 300, 365: 600 });
  });
});

describe("moneyAtRest — cost × sellable on-hand", () => {
  it("multiplies cost by on-hand", () => {
    expect(moneyAtRest(100, 5)).toBe(500);
  });

  it("clamps oversold (negative) positions to zero", () => {
    expect(moneyAtRest(100, -3)).toBe(0);
  });
});

describe("abcForCatalogue — Pareto by sales value, with the '—' overlay", () => {
  // Ten established items of equal value → 70/20/10 cut = 7 A, 2 B, 1 C.
  const established = Array.from({ length: 10 }, (_, i) => ({
    id: `p${i}`,
    history: dailyHistory(365, 1, 100),
    priceKes: 100,
  }));
  const zeroValue = { id: "zero", history: [] as SalesPoint[], priceKes: 100 };

  it("cuts equal-value items 7/2/1 into A/B/C", () => {
    const abc = abcForCatalogue(established, ASOF);
    const counts = { A: 0, B: 0, C: 0 };
    for (const cls of abc.values()) if (cls) counts[cls] += 1;
    expect(counts).toEqual({ A: 7, B: 2, C: 1 });
  });

  it("labels a product with no sales value '—' (null) and excludes it from the cut", () => {
    const abc = abcForCatalogue([...established, zeroValue], ASOF);
    expect(abc.get("zero")).toBeNull();
    // Excluding it leaves the ten established items ranked exactly as before.
    const counts = { A: 0, B: 0, C: 0 };
    for (const id of established.map((e) => e.id)) counts[abc.get(id)!] += 1;
    expect(counts).toEqual({ A: 7, B: 2, C: 1 });
  });

  it("ranks a product that sells, however recently the store listed it", () => {
    // This assertion is the inverse of the one it replaced. Age used to drop a
    // product from the ranking on its own, so a catalogue listed entirely
    // within the new-product window ranked NOTHING and the class column went
    // blank — which is what every workspace in production actually looked like.
    const abc = abcForCatalogue([...established, { id: "fresh", history: dailyHistory(20, 5, 100), priceKes: 100 }], ASOF);
    expect(abc.get("fresh")).not.toBeNull();
  });

  it("still classifies when every product in the catalogue is newly listed", () => {
    const allFresh = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      history: dailyHistory(20, 1, 100),
      priceKes: 100,
    }));
    const abc = abcForCatalogue(allFresh, ASOF);
    expect([...abc.values()].filter((c) => c != null)).toHaveLength(10);
  });

  it("matches the forecast run's assignAbc/dailySalesValue for ranked products", () => {
    const abc = abcForCatalogue(established, ASOF);
    const expected = assignAbc(
      established.map((e) => ({ id: e.id, revenue: dailySalesValue(e.history, e.priceKes, ASOF) }))
    );
    for (const e of established) expect(abc.get(e.id)).toBe(expected[e.id]);
  });
});
