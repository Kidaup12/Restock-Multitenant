import { describe, expect, it } from "vitest";
import { type SalesPoint } from "@wezesha/forecast";
import {
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
