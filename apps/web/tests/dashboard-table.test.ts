import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { getDashboardTable, getTodayMetrics, pileFor } from "../lib/data/today";
import { getBuyList } from "../lib/data/plan";

/**
 * The dashboard's KPI tiles and the table beneath them sit on one screen, so a
 * tile reading 7 beside a tab listing 9 is a contradiction the reader cannot
 * resolve. These hold the two apart-ness bugs that can produce it: a second
 * definition of a pile, and a second definition of the catalogue it is drawn
 * from.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

describe("pileFor (pure)", () => {
  const cutoff = new Date("2026-06-01").getTime();

  it("an empty shelf is a stockout, never dead stock", () => {
    // Both could be argued; counting it twice would make the piles sum past the
    // catalogue, and an empty shelf is the more urgent fact.
    expect(pileFor({ onHandUnits: 0, lastSaleAt: null }, cutoff)).toBe("stockout");
    expect(pileFor({ onHandUnits: -4, lastSaleAt: null }, cutoff)).toBe("stockout");
  });

  it("stock that has never sold is dead", () => {
    expect(pileFor({ onHandUnits: 10, lastSaleAt: null }, cutoff)).toBe("dead");
  });

  it("stock whose last sale predates the window is dead", () => {
    expect(pileFor({ onHandUnits: 10, lastSaleAt: new Date("2026-05-31") }, cutoff)).toBe("dead");
  });

  it("stock that sold inside the window is healthy", () => {
    expect(pileFor({ onHandUnits: 10, lastSaleAt: new Date("2026-06-02") }, cutoff)).toBe("healthy");
  });
});

let seeded: SeedResult;

describe.skipIf(!runnable)("dashboard table (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await runForecast(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("counts the same stockouts and dead stock as the tiles above it", async () => {
    const [table, metrics] = await Promise.all([
      getDashboardTable(seeded.tenantId, { canViewCosts: true }),
      getTodayMetrics(seeded.tenantId, { canViewCosts: true }),
    ]);
    // The whole point of the shared rule.
    expect(table.counts.stockout).toBe(metrics.stockedOutProducts);
    expect(table.counts.dead).toBe(metrics.deadStock.skus);
  });

  it("draws its piles from the same catalogue the tiles count", async () => {
    const [table, metrics] = await Promise.all([
      getDashboardTable(seeded.tenantId, { canViewCosts: true }),
      getTodayMetrics(seeded.tenantId, { canViewCosts: true }),
    ]);
    // Guards the OTHER way the two can drift: same rule, different scope. The
    // tiles count BUYABLE_PRODUCT_WHERE; the table filters the catalogue on
    // `buyable`, and nothing proves those agree except this.
    expect(table.counts.all).toBe(metrics.trackedProducts);
    expect(table.counts.stockout + table.counts.dead + table.healthy).toBe(metrics.trackedProducts);
  });

  /*
   * NOT here: a test proving the table shares the tiles' dead-stock RULE.
   *
   * It was written and then removed, because it could not fail. The seed's dead
   * products are exactly the ones that have never sold, so "no sale inside the
   * window" and the catalogue's "run rate of ~zero" select the same products at
   * every window length — substituting one rule for the other leaves all these
   * assertions green. A test that passes whether or not the bug is present is
   * worse than none: it reads as a guard.
   *
   * Guarding it needs a purpose-built fixture — stock on hand, a real sale
   * inside the run-rate history but outside a short dead window — so the two
   * rules provably disagree. Until then the rule itself is pinned by the pure
   * `pileFor` tests above, and what these DB tests actually guard is SCOPE
   * drift, which is a different (and real) failure.
   */

  it("takes Reorder from the buy list, not a rule of its own", async () => {
    const [table, buyList] = await Promise.all([
      getDashboardTable(seeded.tenantId, { canViewCosts: true }),
      getBuyList(seeded.tenantId, { canViewCosts: true }),
    ]);
    // "Needs restocking" already has one definition in this app, and it has
    // already cost the project once to have two.
    expect(table.counts.reorder).toBe(buyList!.rows.length);
  });

  it("caps the rows it returns but never the counts", async () => {
    const table = await getDashboardTable(seeded.tenantId, { canViewCosts: true, limit: 2 });
    for (const key of ["stockout", "reorder", "onway", "dead", "all"] as const) {
      expect(table.rows[key].length).toBeLessThanOrEqual(2);
      // A capped list reporting its own length is how "8 of 30" gets printed on
      // a morning the planner says 14.
      expect(table.counts[key]).toBeGreaterThanOrEqual(table.rows[key].length);
      expect(table.capped[key]).toBe(table.counts[key] > 2);
    }
  });

  it("withholds cost figures from a money-blind caller", async () => {
    const table = await getDashboardTable(seeded.tenantId, { canViewCosts: false });
    for (const row of table.rows.all) {
      expect(row.costKes).toBeNull();
      expect(row.moneyAtRestKes).toBeNull();
    }
    // Counts and the piling are not cost facts, so they survive.
    expect(table.counts.all).toBeGreaterThan(0);
  });
});
