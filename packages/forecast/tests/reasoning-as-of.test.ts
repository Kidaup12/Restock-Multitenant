import { describe, it, expect } from "vitest";
import { layeredForecast, type ForecastInput } from "../src/layered";

/**
 * The reasoning string is rendered next to LIVE figures — the product page puts
 * it directly under a "Sells/day" and a "Days cover" tile recomputed at request
 * time. Every rate or cover figure the prose quotes is therefore a second
 * opinion on the same question, frozen at the run and read as current.
 *
 * So the prose states the run's decision (a 30-day demand figure, safety stock,
 * reorder point) and never a units/day rate, and any cover it mentions is
 * stamped as of the run rather than written in the present tense.
 *
 * Also pins the thing the cap does NOT do: it clamps the 30-day forecast only,
 * never the daily rate the cover figure divides by.
 */

const RUN_KEY = "2026-03-20";
const TODAY = new Date(`${RUN_KEY}T00:00:00Z`);
const day = (daysAgo: number) => new Date(+TODAY - daysAgo * 864e5);

function baseInput(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    productId: "p1",
    productType: "SERUM",
    vendor: "ACME",
    sku: "SKU-1",
    currentStock: 100,
    abcCategory: "B",
    history: [],
    leadTimeAvg: 7,
    leadTimeStd: 2,
    activePromos: [],
    runDateKey: RUN_KEY,
    ...overrides,
  };
}

/** Steady seller for `days` days ending yesterday. */
const steady = (days: number, qty = 10) =>
  Array.from({ length: days }, (_, i) => ({ date: day(i + 1), quantity: qty }));

/** A figure a reader takes as "how fast this sells" — the tile's question. */
const BARE_RATE = /\d[\d.]*\s*units\/day/;
/** Stock or cover written as though it were today's shelf. */
const PRESENT_TENSE = /current stock/i;

/** Every branch of the prose owes the same two things. */
function expectNoSecondOpinion(reasoning: string) {
  expect(reasoning, "the prose must not quote a second units/day rate").not.toMatch(BARE_RATE);
  expect(reasoning, "stock and cover must not be written in the present tense").not.toMatch(
    PRESENT_TENSE
  );
  if (/cover/i.test(reasoning)) {
    expect(reasoning, "a cover figure must be stamped as of the run").toMatch(/at the run/i);
  }
}

describe("run reasoning does not restate live figures as current", () => {
  it("an ordinary history-derived run", () => {
    const r = layeredForecast(baseInput({ history: steady(120, 4) }));
    expect(r.reasoning).toContain("30 days"); // still explains the decision
    expectNoSecondOpinion(r.reasoning);
  });

  it("a new product rated over its own short window", () => {
    const r = layeredForecast(baseInput({ history: steady(10) }));
    expectNoSecondOpinion(r.reasoning);
  });

  it("a borrowed cold-start run", () => {
    const r = layeredForecast(
      baseInput({
        history: [],
        demandOverride: { forecast30d: 90, source: "borrowed", label: "Borrowed from Shea Butter" },
      })
    );
    expect(r.reasoning).toMatch(/borrowing/i);
    expectNoSecondOpinion(r.reasoning);
  });

  it("an owner-expectation run", () => {
    const r = layeredForecast(
      baseInput({
        history: steady(120, 4),
        demandOverride: { forecast30d: 40, source: "owner_prior", label: "Owner expects ~40/mo" },
      })
    );
    expectNoSecondOpinion(r.reasoning);
  });

  it("a product too new to forecast at all", () => {
    const r = layeredForecast(baseInput({ history: [] }));
    expect(r.reasoning).toMatch(/too new to forecast/);
    expectNoSecondOpinion(r.reasoning);
  });
});

describe("the cap bounds the forecast, not the cover figure", () => {
  it("a capped run still counts stock down at the uncapped rate", () => {
    // 10/day over 10 days inside one calendar month: best month 100, and with a
    // cap multiple of 1 the 300-unit forecast clamps to 100.
    const r = layeredForecast(baseInput({ history: steady(10), capMultiple: 1, currentStock: 100 }));

    expect(r.finalForecast30d).toBe(100);
    expect(r.signals.some((s) => /Capped/.test(s.label))).toBe(true);
    // 100 units at the UNCAPPED 10/day. Had the cap reached the daily rate the
    // answer would be 100 / (100/30) = 30 days — it does not.
    expect(r.daysUntilStockout).toBe(10);
  });
});
