import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CheckIcon } from "@/components/icons";
import { getTenantPlan } from "@/lib/capabilities";
import {
  PLAN_FEATURES,
  PLAN_FEATURE_LABEL,
  PLAN_ORDER,
  PLAN_TIER_LABEL,
  planAllows,
  type PlanFeature,
  type PlanTier,
} from "@/lib/capabilities/plan-features";

export const metadata: Metadata = {
  title: "Plan",
};

/**
 * Which plan this workspace is on and what it includes.
 *
 * Deliberately carries no price, no trial terms and no payment: those are
 * commercial decisions that belong to the business, not values to copy off
 * another build's screen. What this page fixes is that the gating was invisible
 * — a member met "Budget planner is on the Growth plan" as an upsell string with
 * nowhere to go and see the whole picture.
 */

const FEATURES_BY_TIER = (tier: PlanTier): PlanFeature[] =>
  (Object.keys(PLAN_FEATURES) as PlanFeature[]).filter((f) => PLAN_FEATURES[f] === tier);

export default async function PlanPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const plan = membership ? await getTenantPlan(membership.tenantId) : null;
  const currentLabel = PLAN_TIER_LABEL[
    (PLAN_ORDER.find((t) => t === plan) ?? "starter") as PlanTier
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan"
        description={`This workspace is on ${currentLabel}. Here's what each plan includes.`}
      />

      {PLAN_ORDER.map((tier) => {
        const included = planAllows(plan, FEATURES_BY_TIER(tier)[0] ?? "core_ordering");
        return (
          <Card key={tier}>
            <CardHeader
              title={PLAN_TIER_LABEL[tier]}
              subtitle={
                included
                  ? "Included in your plan"
                  : `Adds the following on top of ${PLAN_TIER_LABEL[PLAN_ORDER[PLAN_ORDER.indexOf(tier) - 1]!]}`
              }
            />
            <ul className="px-5 pb-5">
              {FEATURES_BY_TIER(tier).map((feature) => {
                const has = planAllows(plan, feature);
                return (
                  <li key={feature} className="flex items-center gap-2 py-1 text-sm">
                    <span
                      aria-hidden
                      className={has ? "text-positive [&_svg]:size-4" : "text-ink-faint [&_svg]:size-4"}
                    >
                      <CheckIcon />
                    </span>
                    <span className={has ? "text-ink" : "text-ink-muted"}>
                      {PLAN_FEATURE_LABEL[feature]}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}

      <p className="text-sm text-ink-muted">
        To change plan, talk to us — billing isn&apos;t self-serve yet.
      </p>
    </div>
  );
}
