import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { CalendarIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard } from "@/components/ui/skeleton";
import { planFreshnessLabel } from "@/lib/data/forecast-freshness";
import { getBuyList } from "@/lib/data/plan";
import { getTenantPlan, planAllows } from "@/lib/capabilities";
import { RunForecastButton } from "../today/run-forecast-button";
import { PlanView } from "./plan-view";

export const metadata: Metadata = {
  title: "Restock Planner",
};

/** The buy list streams behind its own skeleton; the header paints immediately. */
async function PlanContent({
  tenantId,
  canViewCosts,
  canOverride,
}: {
  tenantId: string;
  canViewCosts: boolean;
  canOverride: boolean;
}) {
  // canViewCosts flows into the query: PlanView is a client component, so the
  // rows serialize to the browser — costs come back null for a money-blind
  // member and the figures never reach the payload.
  const [buyList, plan] = await Promise.all([
    getBuyList(tenantId, { canViewCosts }),
    getTenantPlan(tenantId),
  ]);
  // Gate 2 (plan) for the budget allocator — a Growth feature. Starter sees the
  // checklist mode only; the server action re-checks so the gate can't be spoofed.
  const canBudget = planAllows(plan, "budget_planner");

  if (!buyList) {
    return (
      <EmptyState
        icon={<CalendarIcon />}
        title="No forecast yet"
        description="Run the forecast to build this week's buy list — every product that needs restocking, with quantities and the reasoning behind them."
        action={<RunForecastButton />}
      />
    );
  }

  // Only a truly empty run gets the empty state. A shop with nothing to buy but
  // 47 products the run covered still has something to read — hiding the whole
  // view would take that away from exactly the shops that need it most.
  if (buyList.rows.length === 0 && buyList.excluded.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon />}
        title="Nothing to order right now"
        description="The latest forecast doesn't recommend restocking anything — the next run may change that."
        action={<RunForecastButton />}
      />
    );
  }

  return (
    <PlanView
      buyList={buyList}
      canViewCosts={canViewCosts}
      canBudget={canBudget}
      canOverride={canOverride}
      freshness={planFreshnessLabel(buyList.runDate)}
    />
  );
}

export default async function PlanPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Buy" title="This week's Buy List" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to plan its restocking."
        />
      </div>
    );
  }

  const canViewCosts = hasPermission(membership, "view_costs");
  const canOverride = hasPermission(membership, "approve_orders");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Buy"
        title="This week's Buy List"
        description="Start from what the forecast recommends, plan against a budget, or look ahead at the ordering calendar."
      />
      <Suspense
        fallback={
          // Three mode cards, on the same grid the real chooser uses.
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
          </div>
        }
      >
        <PlanContent
          tenantId={membership.tenantId}
          canViewCosts={canViewCosts}
          canOverride={canOverride}
        />
      </Suspense>
    </div>
  );
}
