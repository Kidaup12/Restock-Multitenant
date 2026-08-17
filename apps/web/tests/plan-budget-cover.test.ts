import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The budget allocator can be given a days-of-cover target as well as a cash cap
 * — "spend this much, but stock to this long". These tests hold the two things
 * that can go wrong with it, and they go through the server action rather than
 * the data layer on purpose.
 *
 * 1. Off must mean off. The control is opt-in, and a reader who never touches it
 *    must get the split this screen has always produced. A leaked default would
 *    silently move every quantity on the screen.
 * 2. On must actually reach the engine. The re-size happens inside `getBuyList`,
 *    so an action that accepts `coverDays` and forgets to pass it down
 *    type-checks, runs, and returns a perfectly plausible split that ignored the
 *    horizon entirely. Asserting against `getBuyList` directly cannot see that
 *    bug — only calling `planBudget` can.
 *
 * Session and revalidation are stubbed, following plan-actions.test.ts; the plan
 * tier and the rows come from the real RLS-scoped database.
 *
 * Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | { tenantId: string; displayName: string | null; role: string; permissions: unknown }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { planBudget } from "../app/(shell)/plan/actions";
import type { BuyListRow } from "../lib/data/plan";
import {
  COVER_MAX,
  COVER_MIN,
  COVER_STEP,
  DEFAULT_BUDGET_COVER_DAYS,
  DEFAULT_COVER_DAYS,
} from "../app/(shell)/plan/cover";

/** Big enough to fund the whole list, so the comparison is about sizing rather
 *  than about which lines the cash happened to reach. */
const BUDGET_KES = 100_000_000;

/**
 * One product stripped back to how a fresh Shopify import arrives: no supplier,
 * no lead-time override. Its lead time is therefore a GUESS (the shared assumed
 * value), not a measurement — and the engine deliberately refuses to floor a
 * re-size on a guess, because that would inflate a real order off a number
 * nobody supplied. It is the only row that can tell a flag read off the measured
 * lead from one read off the displayed lead, since for every other product the
 * two are the same number.
 */
const UNSUPPLIED_SKU = "ARI-MJ-90";

let seeded: SeedResult;
let originalPlan: string | null = null;

const qtyBySku = (rows: BuyListRow[]) => new Map(rows.map((r) => [r.sku, r.recommendedQty]));

/** The funded quantities for a budget, at an optional cover horizon. */
async function fundedAt(coverDays: number | null) {
  const result = await planBudget({ budgetKes: BUDGET_KES, coverDays });
  if (!result.ok) throw new Error(`planBudget refused: ${result.error}`);
  return qtyBySku(result.data.funded);
}

describe.skipIf(!runnable)("budget allocator with a cover target (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await prismaService.product.updateMany({
      where: { tenantId: seeded.tenantId, sku: UNSUPPLIED_SKU },
      data: { supplierId: null, leadTimeDays: null },
    });
    await runForecast(seeded.tenantId);

    // The budget allocator is a Growth feature; the seed ships Starter.
    const tenant = await prismaService.tenant.findUnique({
      where: { id: seeded.tenantId },
      select: { plan: true },
    });
    originalPlan = tenant?.plan ?? null;
    await prismaService.tenant.update({
      where: { id: seeded.tenantId },
      data: { plan: "growth" },
    });

    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = {
      tenantId: seeded.tenantId,
      displayName: "Owner",
      role: "OWNER",
      permissions: null,
    };
  }, 240_000);

  afterAll(async () => {
    if (originalPlan != null) {
      await prismaService.tenant.update({
        where: { id: seeded.tenantId },
        data: { plan: originalPlan },
      });
    }
    await prismaService.$disconnect();
  });

  it("no cover target leaves the split exactly as it was", async () => {
    const absent = await fundedAt(null);
    const explicitUndefined = await planBudget({ budgetKes: BUDGET_KES });
    expect(explicitUndefined.ok).toBe(true);
    if (!explicitUndefined.ok) return;

    expect(absent.size).toBeGreaterThan(0);
    expect(qtyBySku(explicitUndefined.data.funded)).toEqual(absent);
  });

  it("a longer cover target raises the funded quantities", async () => {
    const before = await fundedAt(null);
    const after = await fundedAt(COVER_MAX);

    // At least one funded line must grow. If nothing moves, the horizon never
    // reached the engine — the silent no-op this test exists for.
    const grown = [...after.entries()].filter(
      ([sku, qty]) => before.has(sku) && qty > (before.get(sku) ?? 0)
    );
    expect(
      grown.length,
      `a ${COVER_MAX}-day cover must size at least one funded line above the plan's own horizon`
    ).toBeGreaterThan(0);

    // And nothing may shrink — a longer horizon can only ask for more.
    for (const [sku, qty] of after) {
      if (!before.has(sku)) continue;
      expect(qty, `${sku} shrank under a longer cover`).toBeGreaterThanOrEqual(
        before.get(sku) ?? 0
      );
    }
  });

  it("the horizon the control switches on is honoured, not just the extremes", async () => {
    const plain = await fundedAt(null);
    const dflt = await fundedAt(DEFAULT_COVER_DAYS);
    const stretched = await fundedAt(COVER_MAX);

    // The default sits between the plan's own horizon and the longest offered,
    // so it must not simply echo one of them for every line.
    const differsFromPlain = [...dflt.entries()].some(
      ([sku, qty]) => plain.has(sku) && qty !== plain.get(sku)
    );
    const differsFromMax = [...dflt.entries()].some(
      ([sku, qty]) => stretched.has(sku) && qty !== stretched.get(sku)
    );
    expect(
      differsFromPlain || differsFromMax,
      "the default horizon produced a list identical to both extremes — the value is being ignored"
    ).toBe(true);
  });

  it("the horizon budget mode opens with is a real, offered value", async () => {
    // The control ships switched on at this figure, so it is the horizon most
    // readers will actually see. It has to be inside the stepper's range, or the
    // buttons start from a number they cannot return to.
    expect(DEFAULT_BUDGET_COVER_DAYS).toBeGreaterThanOrEqual(COVER_MIN);
    expect(DEFAULT_BUDGET_COVER_DAYS).toBeLessThanOrEqual(COVER_MAX);
    expect(
      (DEFAULT_BUDGET_COVER_DAYS - COVER_MIN) % COVER_STEP,
      "the opening horizon must sit on the stepper's grid"
    ).toBe(0);

    const opened = await fundedAt(DEFAULT_BUDGET_COVER_DAYS);
    expect(opened.size).toBeGreaterThan(0);
  });

  it("a line whose lead outlasts the horizon says so", async () => {
    // The shortest horizon the stepper offers, against suppliers who take longer.
    // The engine floors those lines at their own lead, so the quantity exceeds
    // what was asked for — and the row must admit that rather than look wrong.
    const short = await planBudget({ budgetKes: BUDGET_KES, coverDays: COVER_MIN });
    expect(short.ok).toBe(true);
    if (!short.ok) return;

    const rows = [...short.data.funded, ...short.data.deferred];
    // The stripped product's lead is a guess, so it is excluded here and gets its
    // own test below.
    const measuredLongLead = rows.filter(
      (r) => r.leadDays > COVER_MIN && r.sku !== UNSUPPLIED_SKU
    );
    expect(
      measuredLongLead.length,
      "the seed needs a supplier slower than the shortest cover"
    ).toBeGreaterThan(0);
    for (const row of measuredLongLead) {
      expect(row.leadFloored, `${row.sku} was floored at its lead but does not say so`).toBe(true);
    }
    for (const row of rows.filter((r) => r.leadDays <= COVER_MIN)) {
      expect(row.leadFloored, `${row.sku} claims a flooring it never got`).toBe(false);
    }
  });

  it("a GUESSED lead never claims a flooring it did not cause", async () => {
    // The distinguishing case. This product displays the assumed 30-day lead, so a
    // flag inferred from the lead ON SCREEN would mark it floored under a 7-day
    // cover. The engine floored nothing — it refuses to size on a guess — so the
    // row must stay silent. Reading the flag off the displayed lead instead of the
    // measured one passes every other assertion in this file and fails only here.
    const short = await planBudget({ budgetKes: BUDGET_KES, coverDays: COVER_MIN });
    expect(short.ok).toBe(true);
    if (!short.ok) return;

    const row = [...short.data.funded, ...short.data.deferred].find(
      (r) => r.sku === UNSUPPLIED_SKU
    );
    expect(row, `${UNSUPPLIED_SKU} must be sized by the run`).toBeDefined();
    expect(
      row!.leadDays,
      "the stripped product should fall back to the assumed lead, which is longer than the shortest cover"
    ).toBeGreaterThan(COVER_MIN);
    expect(
      row!.leadFloored,
      `${UNSUPPLIED_SKU} has no measured lead, so nothing floored its quantity — it must not say otherwise`
    ).toBe(false);
  });

  it("no cover target means nothing claims a flooring", async () => {
    // With no horizon asked for there is no horizon to exceed, so the badge must
    // be silent everywhere — including for the slowest supplier on the list.
    const plain = await planBudget({ budgetKes: BUDGET_KES, coverDays: null });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const rows = [...plain.data.funded, ...plain.data.deferred];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.leadFloored)).toBe(false);
  });

  it("a nonsense horizon is refused rather than clamped silently", async () => {
    const tooLong = await planBudget({ budgetKes: BUDGET_KES, coverDays: 100_000 });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toMatch(/too long/i);

    const zero = await planBudget({ budgetKes: BUDGET_KES, coverDays: 0 });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error).toMatch(/at least one day/i);
  });
});
