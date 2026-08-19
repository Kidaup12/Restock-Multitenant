import { describe, expect, it } from "vitest";
import {
  buildSetupSteps,
  setupProgress,
  type SetupChecklistInput,
} from "../lib/capabilities/setup-checklist";

/**
 * The finish-setup checklist as pure logic — counts in, steps out. What it must
 * never do is call a step done on a shop that still has work behind it, because
 * a green tick is the one thing nobody re-checks.
 */

const READY: SetupChecklistInput = {
  displayName: "A Name",
  shopifyConnected: true,
  productsTotal: 40,
  productsWithCost: 40,
  leadTimesSet: true,
  planChosen: true,
  canManageShop: true,
};

const FRESH: SetupChecklistInput = {
  displayName: null,
  shopifyConnected: false,
  productsTotal: 0,
  productsWithCost: 0,
  leadTimesSet: false,
  planChosen: false,
  canManageShop: true,
};

const byId = (input: SetupChecklistInput) =>
  Object.fromEntries(buildSetupSteps(input).map((s) => [s.id, s]));

describe("buildSetupSteps", () => {
  it("a finished shop has every step done", () => {
    expect(buildSetupSteps(READY).every((s) => s.done)).toBe(true);
    expect(setupProgress(buildSetupSteps(READY))).toEqual({ done: 6, total: 6, percent: 100 });
  });

  it("a brand-new shop has none done", () => {
    expect(buildSetupSteps(FRESH).some((s) => s.done)).toBe(false);
    expect(setupProgress(buildSetupSteps(FRESH)).percent).toBe(0);
  });

  it("keeps a step order that reads personal-first, then the shop's own setup", () => {
    expect(buildSetupSteps(READY).map((s) => s.id)).toEqual([
      "displayName",
      "shopify",
      "products",
      "costs",
      "leadTimes",
      "plan",
    ]);
  });

  it("a partly-priced catalogue is NOT done, and says what is outstanding", () => {
    // The unpriced products are silently absent from the buy list, which is the
    // whole reason the step exists — calling it done would hide that.
    const costs = byId({ ...READY, productsWithCost: 31 }).costs!;
    expect(costs.done).toBe(false);
    expect(costs.detail).toBe("31 of 40 priced — the rest are left off the buy list");
  });

  it("an empty catalogue never reports costs as done", () => {
    // 0 of 0 is arithmetically "all priced" and would tick green on a shop with
    // no products at all.
    const costs = byId(FRESH).costs!;
    expect(costs.done).toBe(false);
    expect(costs.detail).toBe("needed before anything reaches the buy list");
  });

  it("counts one product in the singular", () => {
    expect(byId({ ...FRESH, productsTotal: 1 }).products!.detail).toBe("1 product");
    expect(byId({ ...FRESH, productsTotal: 2 }).products!.detail).toBe("2 products");
  });

  it("a member can act on their own name but not on the shop's setup", () => {
    const steps = buildSetupSteps({ ...FRESH, canManageShop: false });
    expect(steps.find((s) => s.id === "displayName")!.actionable).toBe(true);
    expect(
      steps.filter((s) => s.id !== "displayName").every((s) => s.actionable)
    ).toBe(false);
  });

  it("whose done-ness never depends on who is looking", () => {
    // Permission changes what you can DO about a step, never whether it is done.
    const owner = buildSetupSteps({ ...READY, canManageShop: true }).map((s) => s.done);
    const member = buildSetupSteps({ ...READY, canManageShop: false }).map((s) => s.done);
    expect(member).toEqual(owner);
  });

  it("every step names a destination that exists in the shell", () => {
    const routes = ["/profile", "/settings/connections", "/stock", "/costs", "/suppliers", "/settings/plan"];
    expect(buildSetupSteps(READY).map((s) => s.href)).toEqual(routes);
  });

  it("floors the percentage so a card never reads 100% with work left", () => {
    const steps = buildSetupSteps({ ...READY, planChosen: false });
    expect(setupProgress(steps)).toEqual({ done: 5, total: 6, percent: 83 });
  });
});
