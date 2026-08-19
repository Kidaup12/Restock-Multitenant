import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { OUTSTANDING_PO_STATUSES } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import { InboxIcon } from "@/components/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@/lib/money";
import { getPurchaseOrders } from "@/lib/data/orders";

export const metadata: Metadata = {
  title: "Receiving",
};

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** Days until a promised date, or null when nothing was promised. Counted from
 *  midnight so "arrives in 1 day" does not become 0 at teatime. */
function daysUntil(date: Date | null): number | null {
  if (!date) return null;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(new Date(date)) - midnight(new Date())) / 86_400_000);
}

function Arrival({ expectedAt, isLate }: { expectedAt: Date | null; isLate: boolean }) {
  if (!expectedAt) {
    // No promised date usually means the supplier has no lead time on file, so
    // say that rather than printing a dash nobody can act on.
    return <span className="text-ink-faint">no date — set a lead time</span>;
  }
  const days = daysUntil(expectedAt);
  const when = dayFormat.format(new Date(expectedAt));
  if (isLate) {
    return (
      <span className="text-negative">
        {when} · {days != null && days < 0 ? `${Math.abs(days)}d late` : "overdue"}
      </span>
    );
  }
  return (
    <span>
      {when}
      {days != null && (
        <span className="text-ink-muted"> · {days === 0 ? "today" : `in ${days}d`}</span>
      )}
    </span>
  );
}

async function ReceivingList({ tenantId, canViewCosts }: { tenantId: string; canViewCosts: boolean }) {
  // Only what still has stock to come. A fully received order is history, and
  // history lives on Orders.
  const rows = await getPurchaseOrders(tenantId, {
    canViewCosts,
    statuses: OUTSTANDING_PO_STATUSES,
    // Soonest first: the question this screen answers is what lands next.
    orderBy: [{ expectedAt: { sort: "asc", nulls: "last" } }, { sentAt: "desc" }],
  });

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader title="Nothing on the way" subtitle="Orders you have sent will wait here" />
        <CardContent>
          <EmptyState
            icon={<InboxIcon />}
            title="No deliveries outstanding"
            description="Once a purchase order is sent it appears here until every line has been booked in."
          />
        </CardContent>
      </Card>
    );
  }

  const late = rows.filter((r) => r.isLate).length;

  return (
    <Card>
      <CardHeader
        title={`${rows.length} ${rows.length === 1 ? "delivery" : "deliveries"} outstanding`}
        subtitle={
          late > 0
            ? `${late} past the day the supplier promised`
            : "Soonest first — open one to book stock in"
        }
      />
      <div className="mt-2 pb-2">
        <Table>
          <TableHeader>
            <TableHead>Order</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Arrives</TableHead>
            <TableHead numeric>Received</TableHead>
            <TableHead numeric>Value</TableHead>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const outstanding = row.totalUnits - row.receivedUnits;
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/orders/${row.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {row.poNumber}
                    </Link>
                    {row.status === "partially_received" && (
                      <Badge tone="accent" className="ml-2">
                        part received
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{row.supplierName ?? "—"}</TableCell>
                  <TableCell>
                    <Arrival expectedAt={row.expectedAt} isLate={row.isLate} />
                  </TableCell>
                  <TableCell numeric>
                    {/* Both halves: what is in, and what the shop is still owed. */}
                    {formatNumber(row.receivedUnits)} of {formatNumber(row.totalUnits)}
                    {outstanding > 0 && (
                      <span className="text-ink-muted"> · {formatNumber(outstanding)} to come</span>
                    )}
                  </TableCell>
                  <TableCell numeric>
                    <CostValue amount={row.subtotalKes} canViewCosts={canViewCosts} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

/**
 * What the shop has bought and is still waiting for.
 *
 * The capability existed before this screen did — a purchase order could be
 * received line by line from its own page — but only if you already knew which
 * order to open. Nothing answered "what is due in", which is the question a shop
 * asks at the door when a delivery turns up.
 */
export default async function ReceivingPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Buy" title="Receiving" description="Stock on its way in" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to see its deliveries."
        />
      </div>
    );
  }

  const canViewCosts = hasPermission(membership, "view_costs");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Buy"
        title="Receiving"
        description="Stock on its way in, soonest first — open an order to book it in"
      />
      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={6} />
          </Card>
        }
      >
        <ReceivingList tenantId={membership.tenantId} canViewCosts={canViewCosts} />
      </Suspense>
    </div>
  );
}
