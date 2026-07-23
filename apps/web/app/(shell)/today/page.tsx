import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  SkeletonChart,
  SkeletonStatTile,
  SkeletonTableRows,
} from "@/components/ui/skeleton";
import { MetricsTiles } from "./metrics-tiles";
import { RealtimeRefresh } from "./realtime-refresh";
import { ReorderTable } from "./reorder-table";
import { RevenueTrend } from "./revenue-trend";
import { RunForecastButton } from "./run-forecast-button";

export const metadata: Metadata = {
  title: "Today",
};

/* Each section streams behind its own skeleton; the queries run in parallel. */
export default async function TodayPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Today" description="Your replenishment picture this morning" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to see its replenishment picture."
        />
      </div>
    );
  }

  const tenantId = membership.tenantId;
  // Money-blind gate: MEMBERs (without view_costs) see no KES cost figures.
  const canViewCosts = hasPermission(membership, "view_costs");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Today"
        description="Your replenishment picture this morning"
        actions={<RunForecastButton />}
      />
      <RealtimeRefresh />

      <div data-tour="today-metrics">
        <Suspense
          fallback={
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SkeletonStatTile />
              <SkeletonStatTile />
              <SkeletonStatTile />
              <SkeletonStatTile />
            </div>
          }
        >
          <MetricsTiles tenantId={tenantId} canViewCosts={canViewCosts} />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonChart />
          </Card>
        }
      >
        <RevenueTrend tenantId={tenantId} />
      </Suspense>

      <div data-tour="today-reorder">
        <Suspense
          fallback={
            <Card className="p-5">
              <SkeletonTableRows rows={7} />
            </Card>
          }
        >
          <ReorderTable tenantId={tenantId} canViewCosts={canViewCosts} />
        </Suspense>
      </div>
    </div>
  );
}
