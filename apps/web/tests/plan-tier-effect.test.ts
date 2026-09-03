import { describe, expect, it } from "vitest";
import {
  PLAN_FEATURES,
  PLAN_FEATURE_LABEL,
  PLAN_ORDER,
  featuresGained,
  featuresIncludedIn,
  planAllows,
  type PlanFeature,
} from "../lib/capabilities/plan-features";

/**
 * What a tier includes, and what changing it turns on or off.
 *
 * The operator's tier control described the tiers with a fixed sentence that
 * never changed when the tier did — so nobody moving a customer between plans
 * could see what they were granting, and moving one DOWN gave no warning that a
 * screen someone is using today would stop opening tomorrow.
 *
 * These derive from the same matrix the gates read, so the copy cannot drift
 * from what the app actually enforces.
 */

describe("what a tier includes", () => {
  it("includes everything the tiers below it do", () => {
    const starter = featuresIncludedIn("starter");
    const growth = featuresIncludedIn("growth");
    const scale = featuresIncludedIn("scale");

    for (const f of starter) expect(growth).toContain(f);
    for (const f of growth) expect(scale).toContain(f);
    expect(scale.length).toBe((Object.keys(PLAN_FEATURES) as PlanFeature[]).length);
  });

  it("agrees with the gate the app actually enforces", () => {
    // The copy and the enforcement must come from one source, or the console
    // promises something the screens refuse.
    for (const tier of PLAN_ORDER) {
      for (const f of Object.keys(PLAN_FEATURES) as PlanFeature[]) {
        expect(featuresIncludedIn(tier).includes(f)).toBe(planAllows(tier, f));
      }
    }
  });

  it("puts the forecast and the buy list on the entry tier", () => {
    // The thing a shop buys the product for is never gated.
    expect(featuresIncludedIn("starter")).toEqual(
      expect.arrayContaining(["core_ordering", "run_forecast"]),
    );
  });
});

describe("what changing a tier does", () => {
  it("names what moving up turns on", () => {
    const gained = featuresGained("starter", "growth");
    expect(gained).toEqual(
      expect.arrayContaining([
        "transfers",
        "supplier_po_email",
        "multi_location",
      ]),
    );
    expect(gained).not.toContain("core_ordering");
  });

  it("names what moving down turns off — the direction that costs someone access", () => {
    // featuresGained reversed is the loss, which is what the warning renders.
    expect(featuresGained("growth", "starter")).toEqual([]);
    const lost = featuresGained("growth", "scale");
    expect(lost).toEqual(expect.arrayContaining(["team_depth", "priority_support"]));
  });

  it("says nothing changed when the tier does not move", () => {
    for (const tier of PLAN_ORDER) expect(featuresGained(tier, tier)).toEqual([]);
  });

  it("has a readable label for every feature, so no key can leak to a screen", () => {
    for (const f of Object.keys(PLAN_FEATURES) as PlanFeature[]) {
      expect(PLAN_FEATURE_LABEL[f]).toBeTruthy();
      expect(PLAN_FEATURE_LABEL[f]).not.toContain("_");
    }
  });
});
