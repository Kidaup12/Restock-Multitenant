import Link from "next/link";
import { ClipboardIcon } from "@/components/icons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getPurchaseOrders } from "@/lib/data/orders";
import { PoStatusBadge } from "./po-status-badge";

const day = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Every live purchase order, newest first. */
export async function PoList({
  tenantId,
  canViewCosts = true,
}: {
  tenantId: string;
  canViewCosts?: boolean;
}) {
  const pos = await getPurchaseOrders(tenantId, { canViewCosts });

  return (
    <Card>
      <CardHeader
        title="Purchase orders"
        subtitle={`${pos.length} purchase order${pos.length === 1 ? "" : "s"}`}
      />
      <div className="mt-2 pb-2">
        {pos.length === 0 ? (
          <CardContent>
            <EmptyState
              icon={<ClipboardIcon />}
              title="No purchase orders yet"
              description="Select queued products above and create your first purchase order — or start from the buy list."
              action={
                <Link
                  href="/plan"
                  className="flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
                >
                  Go to the buy list
                </Link>
              }
            />
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableHead>PO</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric>Lines</TableHead>
              <TableHead numeric>Units</TableHead>
              <TableHead numeric>Total</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expected</TableHead>
            </TableHeader>
            <TableBody>
              {pos.map((po) => (
                <TableRow key={po.id}>
                  <TableCell className="font-medium">
                    <Link href={`/orders/${po.id}`} className="text-accent-ink hover:underline">
                      {po.poNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{po.supplierName ?? "—"}</TableCell>
                  <TableCell>
                    <PoStatusBadge status={po.status} />
                  </TableCell>
                  <TableCell numeric>{po.lineCount}</TableCell>
                  <TableCell numeric>
                    {po.receivedUnits > 0 && po.receivedUnits < po.totalUnits
                      ? `${po.receivedUnits}/${po.totalUnits}`
                      : po.totalUnits}
                  </TableCell>
                  <TableCell numeric>
                    <CostValue amount={po.subtotalKes} canViewCosts={canViewCosts} />
                  </TableCell>
                  <TableCell>{day(po.createdAt)}</TableCell>
                  <TableCell>
                    {po.receivedAt
                      ? `Arrived ${day(po.receivedAt)}`
                      : po.expectedAt
                        ? day(po.expectedAt)
                        : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  );
}
