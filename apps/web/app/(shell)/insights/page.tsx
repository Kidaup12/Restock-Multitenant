import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getTenantPlan } from "@/lib/capabilities";
import { PLAN_TIER_LABEL, planAllows, planFeatureTier } from "@/lib/capabilities/plan-features";
import { cn } from "@/lib/cn";
import { BulbIcon } from "@/components/icons";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard, SkeletonStatTile, SkeletonTableRows } from "@/components/ui/skeleton";
import { ForecastScorecard } from "./forecast-scorecard";
import { ShelfHealth } from "./shelf-health";
import { StockoutTrend } from "./stockout-trend";

export const metadata: Metadata = {
  title: "Insights",
};

const DESCRIPTION = "Where your money is stuck, and whether the forecast is earning its keep";

function ViewTabs({ view }: { view: "now" | "proof" }) {
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-accent-soft text-accent-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
      )}
    >
      {label}
    </Link>
  );
  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-edge bg-surface p-1"
      data-tour="insights-tabs"
    >
      {tab("/insights", "Where you stand", view === "now")}
      {tab("/insights?view=proof", "Is it working?", view === "proof")}
    </div>
  );
}

/** Locked shell for a plan that doesn't include Insights — name what it holds so
 *  the owner can see what upgrading buys rather than an empty page. */
function InsightsLocked() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={<BulbIcon />}
          title="Insights is on a higher plan"
          description="See where your shelves are empty, how much cash is sitting in stock that isn't moving, and whether the forecast has been telling you the truth."
          action={
            <p className="text-sm font-medium text-accent-ink">
              Included on the {PLAN_TIER_LABEL[planFeatureTier("insights")]} plan.
            </p>
          }
        />
      </CardContent>
    </Card>
  );
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const view = (await searchParams).view === "proof" ? "proof" : "now";

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Insights" description={DESCRIPTION} />
        <EmptyState
          title="No workspace yet"
          description="Create your shop's workspace to start, or ask an admin to invite you to theirs."
        />
      </div>
    );
  }

  const plan = await getTenantPlan(membership.tenantId);
  // Money-blind gate: MEMBERs (without view_costs) see no KES cost figures.
  const canViewCosts = hasPermission(membership, "view_costs");

  if (!planAllows(plan, "insights")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Insights" description={DESCRIPTION} />
        <InsightsLocked />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Insights" description={DESCRIPTION} />
      <ViewTabs view={view} />

      {view === "now" ? (
        <Suspense
          fallback={
            <div className="space-y-6" role="status" aria-label="Loading shelf health">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <SkeletonStatTile />
                <SkeletonStatTile />
                <SkeletonStatTile />
              </div>
              <SkeletonTableRows rows={6} />
            </div>
          }
        >
          <ShelfHealth tenantId={membership.tenantId} canViewCosts={canViewCosts} />
        </Suspense>
      ) : (
        <div className="space-y-6">
          <Suspense
            fallback={
              <div role="status" aria-label="Loading forecast scorecard">
                <SkeletonCard lines={3} />
              </div>
            }
          >
            <ForecastScorecard tenantId={membership.tenantId} />
          </Suspense>
          <Suspense
            fallback={
              <div role="status" aria-label="Loading stockout trend">
                <SkeletonCard lines={3} />
              </div>
            }
          >
            <StockoutTrend tenantId={membership.tenantId} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
