import { describe, expect, it } from "vitest";
import {
  PLAN_FEATURES,
  PLAN_TIER_LABEL,
  parseFeatureOverrides,
  planAllows,
  planFeatureTier,
} from "../lib/capabilities/plan-features";

/** Gate 2 — plan-feature inclusion: the tier map, the ≥-tier rule, plan-name
 *  aliasing (null / "essential" / unknown → the entry tier). */

describe("planAllows", () => {
  it("includes entry-tier features on every plan", () => {
    for (const plan of ["starter", "growth", "scale"]) {
      expect(planAllows(plan, "core_ordering")).toBe(true);
      expect(planAllows(plan, "run_forecast")).toBe(true);
    }
  });

  it("locks Growth features on the entry tier and opens them at Growth+", () => {
    expect(planAllows("starter", "transfers")).toBe(false);
    expect(planAllows("starter", "supplier_po_email")).toBe(false);
    expect(planAllows("growth", "transfers")).toBe(true);
    expect(planAllows("scale", "transfers")).toBe(true);
  });

  it("includes the budget planner from the entry tier up", () => {
    // Moved to starter deliberately: planning against a budget is core to what
    // the product does, not an upsell, so no tier is without it.
    expect(planAllows("starter", "budget_planner")).toBe(true);
    expect(planAllows(null, "budget_planner")).toBe(true); // null = entry tier
    expect(planAllows("growth", "budget_planner")).toBe(true);
    expect(planAllows("scale", "budget_planner")).toBe(true);
  });

  it("includes insights (Reports) from the entry tier up", () => {
    // Reports moved to Starter deliberately, the same call as the budget
    // planner: a shop cannot judge whether the forecast is earning its keep
    // without seeing where its money is stuck, so no tier is without it.
    expect(planAllows("starter", "insights")).toBe(true);
    expect(planAllows(null, "insights")).toBe(true); // null = entry tier
    expect(planAllows("growth", "insights")).toBe(true);
    expect(planAllows("scale", "insights")).toBe(true);
  });

  it("locks Scale features until Scale", () => {
    expect(planAllows("growth", "team_depth")).toBe(false);
    expect(planAllows("scale", "team_depth")).toBe(true);
  });

  it("treats null and unknown plans as the entry tier", () => {
    expect(planAllows(null, "core_ordering")).toBe(true);
    expect(planAllows(null, "transfers")).toBe(false);
    expect(planAllows("enterprise", "transfers")).toBe(false);
    expect(planAllows("enterprise", "core_ordering")).toBe(true);
  });

  it("accepts the spec's tier spellings as aliases, case-insensitively", () => {
    expect(planAllows("essential", "core_ordering")).toBe(true);
    expect(planAllows("Essential", "transfers")).toBe(false);
    expect(planAllows("Growth", "transfers")).toBe(true);
  });
});

describe("planAllows with per-tenant overrides (operator console)", () => {
  it("a deny wins over the tier — a Scale feature is off for a granted-nothing deny", () => {
    // team_depth is a Scale feature; scale would normally include it.
    expect(planAllows("scale", "team_depth")).toBe(true);
    expect(planAllows("scale", "team_depth", { team_depth: "deny" })).toBe(false);
  });

  it("a grant wins over the tier — a Growth feature is on for an entry-tier tenant", () => {
    // transfers is a Growth feature; starter would normally lock it.
    expect(planAllows("starter", "transfers")).toBe(false);
    expect(planAllows("starter", "transfers", { transfers: "grant" })).toBe(true);
    expect(planAllows(null, "transfers", { transfers: "grant" })).toBe(true);
  });

  it("deny beats grant is not a case — each feature has one override — but deny beats a high tier and grant beats a low one", () => {
    // The precedence is deny -> grant -> tier, so an unrelated grant never
    // rescues a denied feature, and a deny on a feature the tier includes still
    // turns it off.
    expect(planAllows("scale", "transfers", { transfers: "deny" })).toBe(false);
    expect(planAllows("starter", "team_depth", { team_depth: "grant" })).toBe(true);
  });

  it("falls back to the tier when no override applies to the feature", () => {
    // An override on a different feature leaves this one on the tier's own answer.
    expect(planAllows("starter", "transfers", { team_depth: "grant" })).toBe(false);
    expect(planAllows("growth", "transfers", { team_depth: "deny" })).toBe(true);
    expect(planAllows("starter", "transfers", {})).toBe(false);
  });

  it("is backward compatible: omitting overrides is exactly the tier check", () => {
    expect(planAllows("growth", "transfers")).toBe(planAllows("growth", "transfers", {}));
    expect(planAllows("starter", "transfers")).toBe(planAllows("starter", "transfers", undefined));
  });
});

describe("parseFeatureOverrides robustness", () => {
  it("keeps only real feature keys mapped to real overrides", () => {
    expect(parseFeatureOverrides({ transfers: "grant", team_depth: "deny" })).toEqual({
      transfers: "grant",
      team_depth: "deny",
    });
  });

  it("drops unknown feature keys", () => {
    expect(parseFeatureOverrides({ transfers: "grant", not_a_feature: "grant" })).toEqual({
      transfers: "grant",
    });
  });

  it("drops values that are not grant/deny", () => {
    expect(
      parseFeatureOverrides({ transfers: "on", team_depth: true, insights: null, budget_planner: "deny" })
    ).toEqual({ budget_planner: "deny" });
  });

  it("treats null, arrays and non-objects as no overrides", () => {
    for (const bad of [null, undefined, "grant", 42, ["transfers"], [], true]) {
      expect(parseFeatureOverrides(bad)).toEqual({});
    }
  });

  it("round-trips through planAllows: a parsed deny still turns a feature off", () => {
    const overrides = parseFeatureOverrides({ transfers: "deny", junk: "grant" });
    expect(planAllows("scale", "transfers", overrides)).toBe(false);
  });
});

describe("the feature-to-tier map", () => {
  it("names the tier a feature needs, for upgrade copy", () => {
    expect(planFeatureTier("run_forecast")).toBe("starter");
    expect(planFeatureTier("supplier_po_email")).toBe("growth");
    expect(planFeatureTier("budget_planner")).toBe("starter");
    expect(planFeatureTier("team_depth")).toBe("scale");
  });

  it("labels the entry tier as Essential", () => {
    expect(PLAN_TIER_LABEL.starter).toBe("Essential");
    expect(PLAN_TIER_LABEL.growth).toBe("Growth");
    expect(PLAN_TIER_LABEL.scale).toBe("Scale");
  });

  it("keeps the spec's indicative tiers", () => {
    expect(PLAN_FEATURES.core_ordering).toBe("starter");
    expect(PLAN_FEATURES.multi_location).toBe("growth");
    expect(PLAN_FEATURES.insights).toBe("starter");
    expect(PLAN_FEATURES.priority_support).toBe("scale");
  });
});
