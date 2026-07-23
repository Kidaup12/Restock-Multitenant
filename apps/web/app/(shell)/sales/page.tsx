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
import { TopProducts } from "./top-products";

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

  return (
    <div className="space-y-6">
      <PageHeader title="Sales data" description="What sold, when, across every channel" />

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
        <MonthBars tenantId={tenantId} />
      </Suspense>

      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={10} />
          </Card>
        }
      >
        <TopProducts tenantId={tenantId} />
      </Suspense>
    </div>
  );
}
