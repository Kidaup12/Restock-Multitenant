import { PLAN_TIERS } from "@wezesha/db";
import {
  PLAN_ORDER,
  PLAN_TIER_LABEL,
  PLAN_FEATURE_LABEL,
  featuresIncludedIn,
  type PlanTier,
} from "@/lib/capabilities/plan-features";

/**
 * What each plan costs and what it contains.
 *
 * The contents are DERIVED, never listed by hand: the features come from the
 * same map the app gates on, and the caps from the same table the app enforces.
 * A hand-written pricing page is a promise nothing checks — it goes stale the
 * first time a feature moves tier, and the shop discovers the difference by
 * hitting a wall it was told it had paid past.
 *
 * The price is the one thing not derivable from code, because it is not a fact
 * about the software. It stays null until someone with the authority to set it
 * does; the page then says "talk to us" rather than inventing a number, which
 * on a public page would be a commitment nobody made.
 */

export type PlanPrice = {
  tier: PlanTier;
  /** KES per month, or null while pricing is quoted per shop. */
  monthlyKes: number | null;
  /** Who the tier is for, in the shop's terms. */
  bestFor: string;
};

export const PLAN_PRICING: PlanPrice[] = [
  {
    tier: "starter",
    monthlyKes: null,
    bestFor: "A single shop that wants to stop guessing its reorders.",
  },
  {
    tier: "growth",
    monthlyKes: null,
    bestFor: "More than one branch, or a catalogue big enough to need a budget.",
  },
  {
    tier: "scale",
    monthlyKes: null,
    bestFor: "A deeper catalogue and a team that needs its own permissions.",
  },
];

export type PlanCard = {
  tier: PlanTier;
  name: string;
  monthlyKes: number | null;
  bestFor: string;
  /** What this tier adds on top of the one below — an inclusive list repeats
   *  the same six lines three times and hides the actual difference. */
  adds: string[];
  /** Everything it includes, for the comparison further down the page. */
  includes: string[];
  limits: { products: number; members: number };
};

export function planCards(): PlanCard[] {
  return PLAN_ORDER.map((tier, index) => {
    const below = index === 0 ? [] : featuresIncludedIn(PLAN_ORDER[index - 1]!);
    const included = featuresIncludedIn(tier);
    const limits = PLAN_TIERS[tier]!;
    const price = PLAN_PRICING.find((p) => p.tier === tier);
    return {
      tier,
      name: PLAN_TIER_LABEL[tier],
      monthlyKes: price?.monthlyKes ?? null,
      bestFor: price?.bestFor ?? "",
      adds: included.filter((f) => !below.includes(f)).map((f) => PLAN_FEATURE_LABEL[f]),
      includes: included.map((f) => PLAN_FEATURE_LABEL[f]),
      limits: { products: limits.maxProducts, members: limits.maxMembers },
    };
  });
}
