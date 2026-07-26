import { describe, expect, it } from "vitest";
import {
  PLAN_FEATURES,
  PLAN_TIER_LABEL,
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

  it("locks the budget planner on Starter and opens it at Growth+", () => {
    expect(planAllows("starter", "budget_planner")).toBe(false);
    expect(planAllows(null, "budget_planner")).toBe(false); // null = entry tier
    expect(planAllows("growth", "budget_planner")).toBe(true);
    expect(planAllows("scale", "budget_planner")).toBe(true);
  });

  it("locks insights on Starter and opens it at Growth+", () => {
    expect(planAllows("starter", "insights")).toBe(false);
    expect(planAllows(null, "insights")).toBe(false); // null = entry tier
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

describe("the feature-to-tier map", () => {
  it("names the tier a feature needs, for upgrade copy", () => {
    expect(planFeatureTier("run_forecast")).toBe("starter");
    expect(planFeatureTier("supplier_po_email")).toBe("growth");
    expect(planFeatureTier("budget_planner")).toBe("growth");
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
    expect(PLAN_FEATURES.insights).toBe("growth");
    expect(PLAN_FEATURES.priority_support).toBe("scale");
  });
});
