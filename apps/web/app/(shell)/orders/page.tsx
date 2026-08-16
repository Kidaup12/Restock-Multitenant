import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import { ordersQueryToSearch, parseOrdersQuery, type RawSearchParams } from "@/lib/data/orders";
import { OrderQueue } from "./order-queue";
import { PoList } from "./po-list";

export const metadata: Metadata = {
  title: "Orders",
};

/* Queue and PO list stream behind their own skeletons; queries run in parallel. */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  // Both lists' pages and the search live in the URL: the server decides which
  // rows to send, so it has to read what the reader chose.
  const query = parseOrdersQuery(await searchParams);

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
  // Money-blind gate: MEMBERs (without view_costs) see no KES cost figures.
  const canViewCosts = hasPermission(membership, "view_costs");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description="What to buy, and every purchase order from draft to delivered"
      />

      {/* Each list is keyed on its OWN state, so turning a page of one leaves
          the other's boundary mounted instead of flashing a skeleton at it. */}
      <Suspense
        key={`queue${ordersQueryToSearch({ ...query, search: "", poPage: 0 })}`}
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={4} />
          </Card>
        }
      >
        <OrderQueue tenantId={tenantId} query={query} canViewCosts={canViewCosts} />
      </Suspense>

      <Suspense
        key={`po${ordersQueryToSearch({ ...query, queuePage: 0 })}`}
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={5} />
          </Card>
        }
      >
        <PoList tenantId={tenantId} query={query} canViewCosts={canViewCosts} />
      </Suspense>
    </div>
  );
}
