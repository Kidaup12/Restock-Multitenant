import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN,
  GRACE_DAYS,
  PLAN_TIERS,
  computeLimitState,
  graceLeft,
  resolvePlanLimits,
} from "../src/limits";

/** Pure limit math — no database. */

const DAY_MS = 86_400_000;

describe("resolvePlanLimits", () => {
  it("null plan falls back to the starter tier", () => {
    expect(resolvePlanLimits({ plan: null, planLimits: null })).toEqual(PLAN_TIERS[DEFAULT_PLAN]);
  });

  it("unknown plan names fall back to starter instead of throwing", () => {
    expect(resolvePlanLimits({ plan: "enterprise-2029", planLimits: null })).toEqual(
      PLAN_TIERS[DEFAULT_PLAN]
    );
  });

  it("planLimits overrides only the keys it names", () => {
    const limits = resolvePlanLimits({ plan: "growth", planLimits: { maxMembers: 12 } });
    expect(limits.maxMembers).toBe(12);
    expect(limits.maxProducts).toBe(PLAN_TIERS.growth!.maxProducts);
  });

  it("ignores junk override values", () => {
    const limits = resolvePlanLimits({
      plan: "starter",
      planLimits: { maxProducts: "lots", maxMembers: -5, maxOrders30d: Infinity },
    });
    expect(limits).toEqual(PLAN_TIERS.starter);
  });
});

describe("graceLeft", () => {
  const now = new Date("2026-07-23T12:00:00Z");

  it("full grace right at first-over", () => {
    expect(graceLeft(now, now)).toBe(GRACE_DAYS);
  });

  it("counts whole days down", () => {
    expect(graceLeft(new Date(now.getTime() - 3 * DAY_MS), now)).toBe(GRACE_DAYS - 3);
  });

  it("floors at zero once elapsed", () => {
    expect(graceLeft(new Date(now.getTime() - 30 * DAY_MS), now)).toBe(0);
  });
});

describe("computeLimitState", () => {
  const limits = { maxProducts: 10, maxMembers: 3, maxOrders30d: 100 };

  it("flags each over dimension independently", () => {
    const state = computeLimitState(
      { products: 11, members: 3, orders30d: 250 },
      limits,
      null
    );
    expect(state.products.over).toBe(true);
    expect(state.members.over).toBe(false); // at the limit is not over it
    expect(state.orders30d.over).toBe(true);
    expect(state.anyOver).toBe(true);
  });

  it("no grace clock while under every limit", () => {
    const state = computeLimitState({ products: 1, members: 1, orders30d: 1 }, limits, null);
    expect(state.anyOver).toBe(false);
    expect(state.graceLeftDays).toBeNull();
  });

  it("grace counts from the stored anchor", () => {
    const now = new Date("2026-07-23T12:00:00Z");
    const anchor = new Date(now.getTime() - 5 * DAY_MS);
    const state = computeLimitState({ products: 11, members: 1, orders30d: 1 }, limits, anchor, now);
    expect(state.graceLeftDays).toBe(GRACE_DAYS - 5);
  });
});
