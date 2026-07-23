import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { CalendarIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard } from "@/components/ui/skeleton";
import { getBuyList } from "@/lib/data/plan";
import { RunForecastButton } from "../today/run-forecast-button";
import { PlanView } from "./plan-view";

export const metadata: Metadata = {
  title: "Plan",
};

/** The buy list streams behind its own skeleton; the header paints immediately. */
async function PlanContent({
  tenantId,
  canViewCosts,
}: {
  tenantId: string;
  canViewCosts: boolean;
}) {
  const buyList = await getBuyList(tenantId);

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

  if (buyList.rows.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon />}
        title="Nothing to order right now"
        description="The latest forecast doesn't recommend restocking anything — the next run may change that."
        action={<RunForecastButton />}
      />
    );
  }

  return <PlanView buyList={buyList} canViewCosts={canViewCosts} />;
}

export default async function PlanPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Plan" description="Weekly replenishment planning" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to plan its restocking."
        />
      </div>
    );
  }

  const canViewCosts = hasPermission(membership, "view_costs");

  return (
    <div className="space-y-6">
      <PageHeader title="Plan" description="Weekly replenishment planning" />
      <Suspense
        fallback={
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
          </div>
        }
      >
        <PlanContent tenantId={membership.tenantId} canViewCosts={canViewCosts} />
      </Suspense>
    </div>
  );
}
