import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  SkeletonChart,
  SkeletonStatTile,
  SkeletonTableRows,
} from "@/components/ui/skeleton";
import { SalesHeadline } from "./headline";
import { MonthBars } from "./month-bars";
import { PosFixQueue } from "./pos-fix-queue";
import { SalesGaps } from "./sales-gaps";
import { TopProducts } from "./top-products";
import { UnmappedTills } from "./unmapped-tills";

export const metadata: Metadata = {
  title: "Sales data",
};

export default async function SalesPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Sales data" description="Imports and sales history" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to see its sales."
        />
      </div>
    );
  }

  const tenantId = membership.tenantId;
  const currency = membership.tenant.currency;
  const canFix = membership.role === "OWNER" || membership.role === "ADMIN";

  return (
    <div className="space-y-6">
      <PageHeader title="Sales data" description="What sold, when, across every channel" />

      {/* POS data-health surfaces (spec §3). Each hides itself when clean, so a
          healthy tenant sees only the metrics below. */}
      <Suspense fallback={null}>
        <PosFixQueue tenantId={tenantId} canFix={canFix} />
      </Suspense>
      <Suspense fallback={null}>
        <SalesGaps tenantId={tenantId} canFix={canFix} />
      </Suspense>
      <Suspense fallback={null}>
        <UnmappedTills tenantId={tenantId} />
      </Suspense>

      <div data-tour="sales-overview">
        <Suspense
          fallback={
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <SkeletonStatTile />
              <SkeletonStatTile />
              <SkeletonStatTile />
            </div>
          }
        >
          <SalesHeadline tenantId={tenantId} />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonChart />
          </Card>
        }
      >
        <MonthBars tenantId={tenantId} currency={currency} />
      </Suspense>

      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={10} />
          </Card>
        }
      >
        <TopProducts tenantId={tenantId} currency={currency} />
      </Suspense>
    </div>
  );
}
