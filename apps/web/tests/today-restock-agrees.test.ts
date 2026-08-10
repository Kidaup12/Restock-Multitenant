import { beforeAll, describe, expect, it } from "vitest";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getReorderNeeded } from "../lib/data/today";
import { getBuyList } from "../lib/data/plan";
import { runForecast } from "../lib/forecast-run/run";

/**
 * Today and the planner must answer "how many products need restocking?" with
 * the same number, over the same products.
 *
 * They did not. Today applied a filter of its own and then capped the list to
 * eight BEFORE counting it, reporting the page size as the total: "8 of 30" on
 * a morning the planner said 14. Un-capping alone would not have fixed it —
 * Today's filter also kept slow-movers and already-ordered items the planner
 * deliberately holds back, so the two would still have disagreed, at 19 vs 14.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

describe.skipIf(!runnable)("Today's restock count (seeded local db)", () => {
  let seeded: SeedResult;

  beforeAll(async () => {
    seeded = await seedDev();
    await runForecast(seeded.tenantId);
  }, 180_000);

  it("counts what the planner counts, not what the card has room for", async () => {
    const [reorder, buyList] = await Promise.all([
      getReorderNeeded(seeded.tenantId, { canViewCosts: true }),
      getBuyList(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(reorder).not.toBeNull();
    expect(buyList).not.toBeNull();

    expect(reorder!.needingRestock).toBe(buyList!.rows.length);
    expect(reorder!.totalPredicted).toBe(buyList!.totalPredicted);
    // The seeded catalogue must actually exceed the cap, or this proves nothing.
    expect(reorder!.needingRestock).toBeGreaterThan(reorder!.rows.length);
  });

  it("lists the planner's own most urgent rows, in the planner's order", async () => {
    const [reorder, buyList] = await Promise.all([
      getReorderNeeded(seeded.tenantId, { canViewCosts: true }),
      getBuyList(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(reorder!.rows.map((r) => r.productId)).toEqual(
      buyList!.rows.slice(0, reorder!.rows.length).map((r) => r.productId)
    );
  });

  it("never shows a product the planner holds back", async () => {
    const [reorder, buyList] = await Promise.all([
      getReorderNeeded(seeded.tenantId, { canViewCosts: true }),
      getBuyList(seeded.tenantId, { canViewCosts: true }),
    ]);
    const held = new Set(buyList!.excluded.map((r) => r.productId));
    expect(held.size, "the seed must hold something back for this to bite").toBeGreaterThan(0);
    for (const row of reorder!.rows) expect(held.has(row.productId)).toBe(false);
  });
});
