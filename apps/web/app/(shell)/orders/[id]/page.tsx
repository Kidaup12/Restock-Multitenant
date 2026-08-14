import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Badge } from "@/components/ui/badge";
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
import { getPoDetail, type PoDetail } from "@/lib/data/orders";
import { PoStatusBadge } from "../po-status-badge";
import { PoActions } from "./po-actions";
import { ReceiveForm } from "./receive-form";

export const metadata: Metadata = {
  title: "Purchase order",
};

const day = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * What happened to the supplier's email, in words that claim only what the
 * ledger knows. "Delivered" is not one of them: the mail provider accepting a
 * message is not proof anyone read it, so a successful send says the email left
 * us and stops there. A failure says the opposite plainly — the supplier has
 * not seen this order — because the shop's next move depends on knowing that.
 */
function emailNote(email: PoDetail["email"]): { text: string; bad: boolean } {
  if (!email) {
    return {
      text: "No email record for this order — it may have been sent before we started keeping them.",
      bad: false,
    };
  }
  const retries =
    email.earlierAttempts > 0
      ? ` After ${email.earlierAttempts} earlier attempt${email.earlierAttempts === 1 ? "" : "s"}.`
      : "";
  if (email.status === "sent") {
    return {
      text: `Email went out to ${email.to} on ${day(email.at)} — we can't tell whether it has been opened.${retries}`,
      bad: false,
    };
  }
  if (email.status === "skipped") {
    return {
      text: `Email to ${email.to} did not go out — email sending is switched off for this workspace. The supplier has not been told.${retries}`,
      bad: true,
    };
  }
  return {
    text: `Email to ${email.to} did not go out on ${day(email.at)} — the supplier has not seen this order. Send it again or phone them.${retries}`,
    bad: true,
  };
}

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

  // Money-blind gate: MEMBERs (without view_costs) see no KES cost figures.
  const canViewCosts = hasPermission(membership, "view_costs");
  const po = await getPoDetail(membership.tenantId, id, { canViewCosts });
  if (!po) notFound();

  const receivable = po.status === "sent" || po.status === "partially_received";

  const timeline: {
    label: string;
    at: Date | null;
    extra: string | null;
    late?: boolean;
    note?: { text: string; bad: boolean } | null;
  }[] = [
    { label: "Created", at: po.createdAt, extra: po.createdByName ? `by ${po.createdByName}` : null },
    {
      label: "Sent",
      at: po.sentAt,
      // Who sent it matters as much as when: this is the moment the shop
      // committed money to a supplier, and Created already names its actor.
      extra: [
        po.sentByName ? `by ${po.sentByName}` : null,
        // No ETA means the supplier has no lead time on file — say so rather
        // than leave a silence that reads as a delivery on track.
        po.expectedAt
          ? `expected ${day(po.expectedAt)}`
          : po.sentAt
            ? "no delivery date promised"
            : null,
      ]
        .filter(Boolean)
        .join(" · "),
      late: po.isLate,
      // "Sent" has meant "we marked it sent" — this says what became of the
      // email itself, which is the question the shop actually asks. Shown for a
      // draft too when an attempt was logged: a failed send hands the order
      // back to draft, so that is exactly where the bad news has to appear.
      note: po.sentAt || po.email ? emailNote(po.email) : null,
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
        breadcrumbs={[{ label: "Orders", href: "/orders" }, { label: po.poNumber }]}
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
              {step.note && (
                <p
                  className={`mt-1 max-w-xs text-xs ${
                    step.note.bad ? "text-negative" : "text-ink-muted"
                  }`}
                >
                  {step.note.text}
                </p>
              )}
              {step.late && (
                <Badge tone="negative" className="mt-1">
                  Late
                </Badge>
              )}
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
