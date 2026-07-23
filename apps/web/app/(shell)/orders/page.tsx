import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import { OrderQueue } from "./order-queue";
import { PoList } from "./po-list";

export const metadata: Metadata = {
  title: "Orders",
};

/* Queue and PO list stream behind their own skeletons; queries run in parallel. */
export default async function OrdersPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Orders" description="Purchase orders and deliveries" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to manage its purchase orders."
        />
      </div>
    );
  }

  const tenantId = membership.tenantId;
  // The money-blind gate (role-based cost visibility) plugs in here.
  const canViewCosts = true;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description="What to buy, and every purchase order from draft to delivered"
      />

      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={4} />
          </Card>
        }
      >
        <OrderQueue tenantId={tenantId} canViewCosts={canViewCosts} />
      </Suspense>

      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={5} />
          </Card>
        }
      >
        <PoList tenantId={tenantId} canViewCosts={canViewCosts} />
      </Suspense>
    </div>
  );
}
