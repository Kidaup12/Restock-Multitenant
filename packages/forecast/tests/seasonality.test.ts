import { describe, expect, it } from "vitest";
import {
  blendedSeasonalMultiplier,
  boundedMultiplier,
  monthKeyOf,
  seasonalLabel,
  SEASONAL_MAX,
  SEASONAL_MIN,
} from "../src/seasonality";
import { layeredForecast, type ForecastInput } from "../src/layered";
import type { SalesPoint } from "../src/baseline";

/**
 * Seasonality the shop states, not seasonality the calendar guesses.
 *
 * Calendar guesses were in this engine and were removed — backtesting showed
 * they hurt without a full season of history, and no workspace has one. A
 * stated "December is about triple" is knowledge the sales history cannot yet
 * contain, so it is taken on the same terms as a declared promo: a multiplier
 * on the history-derived baseline, still bounded by the runaway cap, and never
 * layered on top of an owner's own stated demand.
 */

const DAY = 86_400_000;
const MONTH_KEY = /\d{4}-\d{2}/;

describe("blending a month multiplier over the horizon", () => {
  it("changes nothing when the shop has stated nothing", () => {
    // The default, and the reason this can ship before anyone uses it.
    expect(blendedSeasonalMultiplier([], new Date(Date.UTC(2026, 11, 20)))).toBe(1);
  });

  it("applies the month in full when the horizon sits inside it", () => {
    const m = blendedSeasonalMultiplier(
      [{ month: "2026-12", multiplier: 3 }],
      new Date(Date.UTC(2026, 11, 1)),
      30
    );
    expect(m).toBeCloseTo(3, 5);
  });

  it("weights by the days the horizon actually spends in each month", () => {
    // From 20 Dec: 12 days of December (x3), 18 of January (unstated, so 1).
    // (12*3 + 18*1) / 30 = 1.8 — not 3, and not 1. This is the difference
    // between ordering for Christmas and ordering for Christmas twice.
    const m = blendedSeasonalMultiplier(
      [{ month: "2026-12", multiplier: 3 }],
      new Date(Date.UTC(2026, 11, 20)),
      30
    );
    expect(m).toBeCloseTo(1.8, 5);
  });

  it("blends two stated months against each other", () => {
    // Christmas run into the quietest month: 12 days x3, 18 days x0.5.
    const m = blendedSeasonalMultiplier(
      [
        { month: "2026-12", multiplier: 3 },
        { month: "2027-01", multiplier: 0.5 },
      ],
      new Date(Date.UTC(2026, 11, 20)),
      30
    );
    expect(m).toBeCloseTo(1.5, 5);
  });

  it("crosses the year boundary without a special case", () => {
    const m = blendedSeasonalMultiplier(
      [{ month: "2027-01", multiplier: 2 }],
      new Date(Date.UTC(2026, 11, 25)),
      30
    );
    // 7 days of Dec (1) + 23 of Jan (2) = 53, over 30.
    expect(m).toBeCloseTo(53 / 30, 5);
  });

  it("counts real days, so February and 31-day months differ", () => {
    const m = blendedSeasonalMultiplier(
      [{ month: "2027-02", multiplier: 2 }],
      new Date(Date.UTC(2027, 1, 1)),
      30
    );
    // Feb 2027 has 28 days: 28 x2 + 2 days of March x1 = 58, over 30.
    expect(m).toBeCloseTo(58 / 30, 5);
  });

  it("returns normal for a zero-day horizon rather than dividing by nothing", () => {
    expect(blendedSeasonalMultiplier([{ month: "2026-12", multiplier: 3 }], new Date(Date.UTC(2026, 11, 1)), 0)).toBe(1);
  });
});

describe("a stated multiplier is bounded before it multiplies anything", () => {
  it("refuses values that are not a usable number", () => {
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) {
      expect(boundedMultiplier(bad as number | null), String(bad)).toBeNull();
    }
  });

  it("clamps a slipped decimal rather than ordering a hundred times over", () => {
    expect(boundedMultiplier(100)).toBe(SEASONAL_MAX);
    expect(boundedMultiplier(0.01)).toBe(SEASONAL_MIN);
  });

  it("leaves a sensible statement exactly as the shop made it", () => {
    expect(boundedMultiplier(3)).toBe(3);
    expect(boundedMultiplier(0.5)).toBe(0.5);
  });

  it("bounds the blend too, not just its inputs", () => {
    const m = blendedSeasonalMultiplier(
      [{ month: "2026-12", multiplier: 999 }],
      new Date(Date.UTC(2026, 11, 1)),
      30
    );
    expect(m).toBeLessThanOrEqual(SEASONAL_MAX);
  });
});

describe("what the shop is told", () => {
  it("says nothing at all for a normal month", () => {
    expect(seasonalLabel(1)).toBeNull();
    expect(seasonalLabel(1.002)).toBeNull();
  });

  it("names the direction in plain words", () => {
    expect(seasonalLabel(1.8)).toContain("Busier");
    expect(seasonalLabel(1.8)).toContain("+80%");
    expect(seasonalLabel(0.5)).toContain("Quieter");
  });

  it("never prints a month key or the word multiplier", () => {
    for (const m of [0.5, 1.8, 3]) {
      const label = seasonalLabel(m)!;
      expect(label).not.toMatch(MONTH_KEY);
      expect(label).not.toContain("multiplier");
    }
  });
});

describe("monthKeyOf", () => {
  it("matches the YYYY-MM the month is stored under", () => {
    expect(monthKeyOf(new Date(Date.UTC(2026, 11, 25)))).toBe("2026-12");
    expect(monthKeyOf(new Date(Date.UTC(2027, 0, 1)))).toBe("2027-01");
  });
});

/* ── through the engine ──────────────────────────────────────────────────── */

const ANCHOR = Date.UTC(2026, 11, 1);

function history(days: number, perDay: number): SalesPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(ANCHOR - (i + 1) * DAY),
    quantity: perDay,
    revenueKes: perDay * 100,
  }));
}

function input(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    productId: "p-1",
    productType: "Skincare",
    vendor: "Acme",
    sku: "SKU-1",
    currentStock: 0,
    abcCategory: "A",
    history: history(120, 2),
    leadTimeAvg: 7,
    leadTimeStd: 2,
    activePromos: [],
    runDateKey: "2026-12-01",
    ...over,
  };
}

describe("the engine takes stated seasonality like a declared promo", () => {
  it("orders more for a month the shop says is busier", () => {
    const normal = layeredForecast(input());
    const busy = layeredForecast(input({ monthlyExpectations: [{ month: "2026-12", multiplier: 2 }] }));
    expect(busy.finalForecast30d).toBeGreaterThan(normal.finalForecast30d);
    expect(busy.recommendedQty).toBeGreaterThan(normal.recommendedQty);
  });

  it("orders less for a month the shop says is quieter", () => {
    const normal = layeredForecast(input());
    const quiet = layeredForecast(input({ monthlyExpectations: [{ month: "2026-12", multiplier: 0.5 }] }));
    expect(quiet.finalForecast30d).toBeLessThan(normal.finalForecast30d);
  });

  it("changes nothing when no month is stated", () => {
    // Byte-identical to the pre-seasonality behaviour, which is what lets this
    // ship to shops that have declared nothing.
    expect(layeredForecast(input({ monthlyExpectations: [] }))).toEqual(layeredForecast(input()));
  });

  it("explains itself on the row, in the shop's words", () => {
    const busy = layeredForecast(input({ monthlyExpectations: [{ month: "2026-12", multiplier: 2 }] }));
    const signal = busy.signals.find((s) => /Busier|Quieter/.test(s.label));
    expect(signal, "no seasonal signal").toBeDefined();
    expect(signal!.label).not.toMatch(MONTH_KEY);
  });

  it("stays inside the runaway cap", () => {
    // The cap is the backstop the whole of Layer 2 depends on; seasonality must
    // not become a way around it.
    //
    // Asserted by the cap BINDING rather than by recomputing its value here:
    // `bestTrailingMonth` is private to the engine, and a test that re-derives
    // the number drifts from the thing it is guarding. Once the cap is reached,
    // asking for more must not give more.
    const plain = layeredForecast(input());
    const beyond = layeredForecast(input({ monthlyExpectations: [{ month: "2026-12", multiplier: 4 }] }));

    expect(beyond.signals.some((s) => /Capped/.test(s.label)), "the cap never fired").toBe(true);
    // The multiplier asked for 4x the baseline; the cap gave back less.
    expect(beyond.finalForecast30d).toBeLessThan(plain.finalForecast30d * 4);
    expect(beyond.finalForecast30d).toBeGreaterThan(plain.finalForecast30d);
    expect(Number.isFinite(beyond.recommendedQty)).toBe(true);
    expect(beyond.recommendedQty).toBeGreaterThanOrEqual(0);
  });

  it("never doubles up on an owner's own stated demand", () => {
    // An override IS the stated demand — the same reason promo is skipped there.
    // The field is `demandOverride`; naming it anything else silently tests the
    // no-override path against itself, which is how this test first "failed".
    const demandOverride = {
      forecast30d: 40,
      source: "owner_prior" as const,
      label: "Owner expects ~40/mo",
    };
    const plain = layeredForecast(input({ demandOverride }));
    expect(plain.finalForecast30d).toBe(40); // the override really is in force
    const seasoned = layeredForecast(
      input({ demandOverride, monthlyExpectations: [{ month: "2026-12", multiplier: 3 }] })
    );
    expect(seasoned.finalForecast30d).toBe(40);
    expect(seasoned.signals.some((s) => /Busier|Quieter/.test(s.label))).toBe(false);
  });

  it("keeps every engine invariant under a stated month", () => {
    for (const multiplier of [0.25, 0.5, 1, 2, 4]) {
      const r = layeredForecast(input({ monthlyExpectations: [{ month: "2026-12", multiplier }] }));
      expect(Number.isFinite(r.finalForecast30d), String(multiplier)).toBe(true);
      expect(r.finalForecast30d).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.recommendedQty)).toBe(true);
      expect(r.safetyStock).toBeGreaterThanOrEqual(0);
      expect(r.reasoning).not.toContain("NaN");
    }
  });
});
