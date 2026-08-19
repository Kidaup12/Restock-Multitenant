import { Suspense } from "react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  Skeleton,
  SkeletonChart,
  SkeletonStatTile,
  SkeletonTableRows,
} from "@/components/ui/skeleton";
import { RealtimeRefresh } from "./realtime-refresh";
import { RevenueTrend } from "./revenue-trend";
import { RunForecastButton } from "./run-forecast-button";
import { TodayLimitNotice } from "./today-limit-notice";
import { TodaySetupStrip } from "./today-setup-strip";
import { CostGapBar } from "./setup-gap-bars";
import { ProductBoard } from "./product-board";

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
        <PageHeader title="Today's replenishment view" />
        <EmptyState
          title="No workspace yet"
          description="Create your shop's workspace to start, or ask an admin to invite you to theirs."
          action={
            <ButtonLink href="/workspaces/new">
              Create a workspace
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const tenantId = membership.tenantId;
  // Money-blind gate: MEMBERs (without view_costs) see no KES cost figures.
  const canViewCosts = hasPermission(membership, "view_costs");
  // Plan usage is the owner's decision to act on — staff can't free a place or
  // change the plan, so they aren't shown the nudge.
  const canManageTeam = hasPermission(membership, "manage_team");
  // Whether the setup steps are this caller's to do. The screens they lead to
  // (connections, costs, plan) gate management on this same permission, so an
  // offered CTA never dead-ends on a permission error.
  const canManageShop = hasPermission(membership, "manage_settings");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={membership.tenant.name}
        title="Today's replenishment view"
        actions={<RunForecastButton />}
      />
      <RealtimeRefresh />

      <Suspense
        fallback={
          <Card className="px-5 py-4">
            {/* The shared skeleton, not a bare pulse: this sat beside four
                shimmering tiles and read as a different kind of loading. */}
            <Skeleton className="h-6 w-full" />
          </Card>
        }
      >
        <TodaySetupStrip
          tenantId={tenantId}
          displayName={session.user.name}
          canManageShop={canManageShop}
        />
      </Suspense>

      {canManageTeam ? (
        <Suspense fallback={null}>
          <TodayLimitNotice tenantId={tenantId} />
        </Suspense>
      ) : null}

      <Suspense fallback={null}>
        <CostGapBar tenantId={tenantId} canViewCosts={canViewCosts} />
      </Suspense>

      <div data-tour="today-metrics">
        <Suspense
          fallback={
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <SkeletonStatTile />
                <SkeletonStatTile />
                <SkeletonStatTile />
                <SkeletonStatTile />
              </div>
              <Card className="p-5">
                <SkeletonChart />
              </Card>
              <Card className="p-5">
                <SkeletonTableRows rows={7} />
              </Card>
            </div>
          }
        >
          {/* The chart is rendered here, on the server, and handed to the board
              so it can sit beside the health list without that list needing its
              data or a second read. */}
          <ProductBoard
            tenantId={tenantId}
            canViewCosts={canViewCosts}
            trend={
              <RevenueTrend tenantId={tenantId} currency={membership.tenant.currency} />
            }
          />
        </Suspense>
      </div>

    </div>
  );
}
