import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { activeMembership, requireSession } from "@/lib/auth";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getPoDetail } from "@/lib/data/orders";
import { PoStatusBadge } from "../po-status-badge";
import { PoActions } from "./po-actions";
import { ReceiveForm } from "./receive-form";

export const metadata: Metadata = {
  title: "Purchase order",
};

const day = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default async function PoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Purchase order" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to manage its purchase orders."
        />
      </div>
    );
  }

  const po = await getPoDetail(membership.tenantId, id);
  if (!po) notFound();

  // The money-blind gate (role-based cost visibility) plugs in here.
  const canViewCosts = true;
  const receivable = po.status === "sent" || po.status === "partially_received";

  const timeline = [
    { label: "Created", at: po.createdAt, extra: po.createdByName ? `by ${po.createdByName}` : null },
    {
      label: "Sent",
      at: po.sentAt,
      extra: po.expectedAt ? `expected ${day(po.expectedAt)}` : null,
    },
    po.cancelledAt
      ? { label: "Cancelled", at: po.cancelledAt, extra: null }
      : {
          label: "Received",
          at: po.receivedAt,
          extra:
            po.receivedUnits > 0 && po.receivedUnits < po.totalUnits
              ? `${po.receivedUnits}/${po.totalUnits} units in`
              : null,
        },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={po.poNumber}
        description={po.supplier ? `Purchase order for ${po.supplier.name}` : "Purchase order"}
        actions={
          <div className="flex items-center gap-2">
            <PoStatusBadge status={po.status} />
            <PoActions
              poId={po.id}
              status={po.status}
              supplierEmail={po.supplier?.email ?? null}
            />
          </div>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap gap-x-10 gap-y-3">
          {timeline.map((step) => (
            <div key={step.label}>
              <p className="text-xs font-medium tracking-wider text-ink-muted uppercase">
                {step.label}
              </p>
              <p className="mt-0.5 text-sm font-medium text-ink">
                {step.at ? day(step.at) : "—"}
              </p>
              {step.extra && <p className="text-xs text-ink-muted">{step.extra}</p>}
            </div>
          ))}
          <div className="ml-auto text-right">
            <p className="text-xs font-medium tracking-wider text-ink-muted uppercase">Total</p>
            <p className="mt-0.5 text-sm font-semibold text-ink">
              <CostValue amount={po.subtotalKes} canViewCosts={canViewCosts} />
            </p>
            <p className="text-xs text-ink-muted">
              {po.lines.length} line{po.lines.length === 1 ? "" : "s"} · {po.totalUnits} units
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Lines"
          subtitle={
            receivable
              ? "Enter what arrived — partial deliveries are fine, the rest stays expected"
              : undefined
          }
          action={
            <Link
              href={`/orders/${po.id}/print`}
              className="text-sm font-medium text-accent-ink hover:underline"
            >
              Print view
            </Link>
          }
        />
        <div className="mt-2 pb-2">
          {receivable ? (
            <ReceiveForm
              poId={po.id}
              lines={po.lines.map((l) => ({
                id: l.id,
                sku: l.sku,
                title: l.title,
                quantity: l.quantity,
                receivedQty: l.receivedQty,
              }))}
              locations={po.locations}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead numeric>Qty</TableHead>
                <TableHead numeric>Received</TableHead>
                <TableHead numeric>Unit cost</TableHead>
                <TableHead numeric>Total</TableHead>
              </TableHeader>
              <TableBody>
                {po.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                    <TableCell className="font-medium text-ink">{line.title}</TableCell>
                    <TableCell numeric>{line.quantity}</TableCell>
                    <TableCell numeric>
                      {line.receivedQty > 0 ? `${line.receivedQty}/${line.quantity}` : "—"}
                    </TableCell>
                    <TableCell numeric>
                      <CostValue amount={line.unitCostKes} canViewCosts={canViewCosts} />
                    </TableCell>
                    <TableCell numeric>
                      <CostValue amount={line.lineTotalKes} canViewCosts={canViewCosts} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  );
}
