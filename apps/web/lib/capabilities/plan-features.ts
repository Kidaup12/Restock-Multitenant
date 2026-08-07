/**
 * Capability gate 2 — plan tier. Beyond the count limits in lib/limits (product
 * / member / order caps), the subscription also gates *features*. This maps each
 * plan feature to the lowest tier that includes it and answers
 * planAllows(plan, feature). It EXTENDS lib/limits (feature inclusion); it does
 * not replace the count-limit checks there.
 *
 * The DB stores canonical plan keys (starter/growth/scale; null = starter, per
 * @wezesha/db limits). The spec's indicative names map onto them 1:1 — "starter"
 * is the entry "Essential" tier — and the aliases below accept either spelling.
 *
 *   Essential (starter)  order + costs + one location
 *   Growth               + suppliers / PO-email, multi-location / transfers, insights
 *   Scale                + team depth, higher limits, priority support
 */

/** Tiers, entry-first. Index = rank. */
export const PLAN_ORDER = ["starter", "growth", "scale"] as const;
export type PlanTier = (typeof PLAN_ORDER)[number];

/** Display names (the spec's indicative tier labels). */
export const PLAN_TIER_LABEL: Record<PlanTier, string> = {
  starter: "Essential",
  growth: "Growth",
  scale: "Scale",
};

/** Accept both the canonical key and the spec's display spelling. */
const PLAN_ALIAS: Record<string, PlanTier> = {
  starter: "starter",
  essential: "starter",
  growth: "growth",
  scale: "scale",
};

// null / unknown = the entry tier (DEFAULT_PLAN = "starter" in @wezesha/db limits).
function toTier(plan: string | null | undefined): PlanTier {
  return PLAN_ALIAS[(plan ?? "starter").toLowerCase()] ?? "starter";
}

function rank(plan: string | null | undefined): number {
  return PLAN_ORDER.indexOf(toTier(plan));
}

/**
 * A caller-supplied tier, normalised to the canonical key, or null if it is not
 * a tier at all. For writers: the aliases accept "Essential", but only
 * "starter" belongs in the column, so a tier that came from a form is resolved
 * here rather than stored as typed.
 */
export function toPlanTier(value: string | null | undefined): PlanTier | null {
  if (value == null) return null;
  return PLAN_ALIAS[value.trim().toLowerCase()] ?? null;
}

export type PlanFeature =
  | "core_ordering"
  | "run_forecast"
  | "supplier_po_email"
  | "transfers"
  | "multi_location"
  | "insights"
  | "budget_planner"
  | "team_depth"
  | "priority_support";

/** Feature → the lowest tier that includes it. */
export const PLAN_FEATURES: Record<PlanFeature, PlanTier> = {
  core_ordering: "starter",
  run_forecast: "starter",
  supplier_po_email: "growth",
  transfers: "growth",
  multi_location: "growth",
  insights: "growth",
  budget_planner: "growth",
  team_depth: "scale",
  priority_support: "scale",
};

/**
 * What each feature is called, in the shop's words rather than the key's.
 *
 * Shared because two surfaces name the same things: the customer's own plan
 * page, and the operator's tier control — which used to describe the tiers with
 * a fixed sentence that never changed when the tier did, so nobody changing a
 * plan could see what they were granting or taking away.
 */
export const PLAN_FEATURE_LABEL: Record<PlanFeature, string> = {
  core_ordering: "Buy list, orders and receiving",
  run_forecast: "Nightly forecast and re-runs",
  supplier_po_email: "Email purchase orders to suppliers",
  transfers: "Move stock between locations",
  multi_location: "More than one location",
  insights: "Insights and shelf health",
  budget_planner: "Plan against a budget",
  team_depth: "Larger team with per-person permissions",
  priority_support: "Priority support",
};

/** Everything a tier includes — its own features plus every lower tier's. */
export function featuresIncludedIn(tier: PlanTier): PlanFeature[] {
  return (Object.keys(PLAN_FEATURES) as PlanFeature[]).filter((f) => planAllows(tier, f));
}

/** What moving from one tier to another turns on (or, reversed, turns off). */
export function featuresGained(from: PlanTier, to: PlanTier): PlanFeature[] {
  const had = new Set(featuresIncludedIn(from));
  return featuresIncludedIn(to).filter((f) => !had.has(f));
}

/** The tier a feature needs (for upgrade copy). */
export function planFeatureTier(feature: PlanFeature): PlanTier {
  return PLAN_FEATURES[feature];
}

/** Does this plan include the feature? (≥ the feature's minimum tier.) */
export function planAllows(
  plan: string | null | undefined,
  feature: PlanFeature,
): boolean {
  return rank(plan) >= rank(PLAN_FEATURES[feature]);
}
