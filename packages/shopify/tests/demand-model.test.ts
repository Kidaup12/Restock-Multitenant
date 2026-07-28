import { describe, expect, it } from "vitest";
import { dailyUnits, seasonFactor, simulate, weekdayFactor, type SeedSku } from "../scripts/lib/demand-model";
import { buildCatalogue, CATALOGUE_SIZE } from "../scripts/lib/catalogue";

/**
 * The generated store is only useful if its shapes are the ones the forecast
 * reacts to. These check the model produces those shapes — determinism first,
 * because a run that gets rate-limited halfway has to resume identically.
 */

const TODAY = new Date("2026-07-28T00:00:00Z");
const DAY_MS = 86_400_000;

function sku(over: Partial<SeedSku> = {}): SeedSku {
  return {
    sku: "WZ-0001",
    title: "Test Product",
    archetype: "steady",
    priceKes: 1000,
    costKes: 600,
    base: 2,
    trendPerDay: 0,
    firstSaleDaysAgo: 400,
    lastSaleDaysAgo: 0,
    stockouts: [],
    promos: [],
    seasonPhase: 0,
    finalStock: 40,
    ...over,
  };
}

const dayAt = (daysAgo: number) => new Date(TODAY.getTime() - daysAgo * DAY_MS);

describe("demand model", () => {
  it("is deterministic — the same SKU and day always give the same units", () => {
    const s = sku();
    const first = Array.from({ length: 30 }, (_, i) => dailyUnits(s, dayAt(i), i));
    const again = Array.from({ length: 30 }, (_, i) => dailyUnits(s, dayAt(i), i));
    expect(again).toEqual(first);
  });

  it("gives different SKUs different days", () => {
    const a = Array.from({ length: 60 }, (_, i) => dailyUnits(sku({ sku: "WZ-A" }), dayAt(i), i));
    const b = Array.from({ length: 60 }, (_, i) => dailyUnits(sku({ sku: "WZ-B" }), dayAt(i), i));
    expect(a).not.toEqual(b);
  });

  it("sells nothing while out of stock — a real gap, not a slow patch", () => {
    const s = sku({ base: 20, stockouts: [{ fromDaysAgo: 40, toDaysAgo: 30 }] });
    for (let d = 40; d >= 30; d--) expect(dailyUnits(s, dayAt(d), d)).toBe(0);
    // and trading resumes either side
    const around = [45, 44, 29, 28].map((d) => dailyUnits(s, dayAt(d), d));
    expect(around.some((u) => u > 0)).toBe(true);
  });

  it("sells nothing before launch or after it stops", () => {
    const s = sku({ base: 20, firstSaleDaysAgo: 30, lastSaleDaysAgo: 10 });
    expect(dailyUnits(s, dayAt(31), 31)).toBe(0);
    expect(dailyUnits(s, dayAt(5), 5)).toBe(0);
    expect(dailyUnits(s, dayAt(20), 20)).toBeGreaterThan(0);
  });

  it("makes a promotion big enough for the spike detector to see", () => {
    // Detection needs both a multiple of the median AND at least 8 units.
    const s = sku({ base: 1, promos: [{ fromDaysAgo: 7, toDaysAgo: 5, multiple: 8 }] });
    for (let d = 7; d >= 5; d--) {
      const units = dailyUnits(s, dayAt(d), d);
      if (units > 0) expect(units).toBeGreaterThanOrEqual(8);
    }
  });

  it("has a busier Saturday than Monday, and a real December", () => {
    expect(weekdayFactor(new Date("2026-07-25T00:00:00Z"))).toBeGreaterThan(
      weekdayFactor(new Date("2026-07-27T00:00:00Z"))
    );
    expect(seasonFactor(new Date("2026-12-10T00:00:00Z"), 0)).toBeGreaterThan(
      seasonFactor(new Date("2026-09-10T00:00:00Z"), 0)
    );
  });

  it("a rising and a falling SKU end up genuinely different", () => {
    const riser = simulate(sku({ sku: "WZ-UP", trendPerDay: 0.0025 }), 400, TODAY);
    const faller = simulate(sku({ sku: "WZ-DOWN", trendPerDay: -0.0025 }), 400, TODAY);
    expect(riser.units).toBeGreaterThan(faller.units * 1.5);
  });
});

describe("catalogue", () => {
  const catalogue = buildCatalogue({ horizonDays: 455 });

  it("builds one row per variant, with unique SKUs", () => {
    expect(catalogue).toHaveLength(CATALOGUE_SIZE);
    expect(new Set(catalogue.map((s) => s.sku)).size).toBe(CATALOGUE_SIZE);
  });

  it("is reproducible from the seed", () => {
    expect(buildCatalogue({ horizonDays: 455 })).toEqual(catalogue);
  });

  it("carries the cost problems the buy list has to exclude", () => {
    expect(catalogue.filter((s) => s.costKes === null).length).toBeGreaterThan(0);
    expect(catalogue.filter((s) => s.costKes !== null && s.costKes > s.priceKes).length).toBeGreaterThan(0);
  });

  it("contains stock that is dead, new, never-sold and out right now", () => {
    const dead = catalogue.filter((s) => s.archetype === "dead");
    const fresh = catalogue.filter((s) => s.archetype === "new");
    const never = catalogue.filter((s) => s.archetype === "no-history");
    expect(dead.length).toBeGreaterThan(0);
    expect(fresh.length).toBeGreaterThan(0);
    expect(never.length).toBeGreaterThan(0);
    expect(catalogue.filter((s) => s.finalStock === 0).length).toBeGreaterThan(0);

    // Dead stock has to look dead: months since the last sale, stock on hand.
    const sim = simulate(dead[0]!, 455, TODAY);
    expect(sim.daysSinceLastSale).toBeGreaterThan(120);
    expect(dead[0]!.finalStock).toBeGreaterThan(0);

    // Never-sold really means never.
    expect(simulate(never[0]!, 455, TODAY).units).toBe(0);
  });

  it("spreads sales value widely enough for ABC to have three classes", () => {
    const values = catalogue
      .map((s) => simulate(s, 455, TODAY).revenue)
      .filter((v) => v > 0)
      .sort((a, b) => b - a);
    // Top seller worth orders of magnitude more than the median earner.
    const median = values[Math.floor(values.length / 2)]!;
    expect(values[0]! / Math.max(median, 1)).toBeGreaterThan(20);
  });
});
