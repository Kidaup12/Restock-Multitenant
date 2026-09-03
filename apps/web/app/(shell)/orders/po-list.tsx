import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { ClipboardIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { Pager } from "@/components/ui/pager";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSearch } from "@/components/ui/table-search";
import {
  countPurchaseOrders,
  getPurchaseOrders,
  ordersQueryFields,
  ordersQueryToSearch,
  poListPageBounds,
  withOrdersQuery,
  type OrdersQuery,
} from "@/lib/data/orders";
import { PoStatusBadge } from "./po-status-badge";
import { QbEvidenceBadge } from "./qb-evidence-badge";
import { prismaForTenant } from "@wezesha/db";

const day = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Every live purchase order, newest first, one page at a time. */
export async function PoList({
  tenantId,
  query,
  canViewCosts = true,
}: {
  tenantId: string;
  query: OrdersQuery;
  canViewCosts?: boolean;
}) {
  // Count first: the page has to be clamped against the real total before the
  // rows are fetched, or a bookmarked page 2 of a list since searched down comes
  // back empty. `total` is the unsearched list, so narrowing the table never
  // makes the rest of it look deleted.
  // The evidence column shows only for a shop whose books we can actually read.
  const qbConnected =
    (await prismaForTenant(tenantId).quickBooksConnection.findFirst({ select: { id: true } })) !== null;
  // Counted across the whole list, not the page: a shop with three phantom
  // orders on page 4 needs to know on page 1.
  const phantomCount = qbConnected
    ? await prismaForTenant(tenantId).purchaseOrder.count({
        where: { needsAttention: true, qbConfirmedAt: null, deletedAt: null, status: { not: "cancelled" } },
      })
    : 0;
  const total = await countPurchaseOrders(tenantId);
  const matched = query.search
    ? await countPurchaseOrders(tenantId, { search: query.search })
    : total;
  const { pageCount, current, start } = poListPageBounds(matched, query.poPage);
  const rows = await getPurchaseOrders(tenantId, {
    canViewCosts,
    search: query.search,
    page: current,
  });

  const hrefFor = (patch: Partial<OrdersQuery>) =>
    `/orders${ordersQueryToSearch(withOrdersQuery(query, patch))}`;

  return (
    <Card>
      {/* The one piece of QuickBooks evidence worth interrupting for: stock is
          committed to a supplier and the accounts have no record of it, which
          is how an invoice gets paid twice or never. Counted across the whole
          list, so it does not depend on which page someone is looking at. */}
      {phantomCount > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-edge bg-warning-soft px-5 py-3 text-sm text-warning">
          <span className="font-medium">
            {phantomCount} sent {phantomCount === 1 ? "order is" : "orders are"} not in QuickBooks
          </span>
          <span>— check they were entered, or they will not be paid.</span>
        </p>
      )}
      <CardHeader
        title="Purchase orders"
        // The whole list, not the page and not the search: a reader who narrows
        // it to one order should still see how much they narrowed it from.
        subtitle={`${total} purchase order${total === 1 ? "" : "s"}`}
      />
      {(total > 0 || query.search) && (
        <TableSearch
          action="/orders"
          value={query.search}
          // The queue's page rides along; this list's own page is dropped, which
          // is the reset back to page 1.
          hidden={ordersQueryFields(query)}
          placeholder="Search by PO number, supplier, or a product on the order"
          matched={query.search ? matched : null}
          clearHref={hrefFor({ search: "" })}
          label="Search purchase orders"
        />
      )}
      <div className="mt-2 pb-2">
        {rows.length === 0 && query.search ? (
          <CardContent>
            <EmptyState
              icon={<ClipboardIcon />}
              title="Nothing matches that"
              description="Try the PO number on its own, or the supplier's name."
            />
          </CardContent>
        ) : rows.length === 0 ? (
          <CardContent>
            <EmptyState
              icon={<ClipboardIcon />}
              title="No purchase orders yet"
              description="Select queued products above and create your first purchase order — or start from the buy list."
              action={
                <ButtonLink href="/plan">Go to the buy list</ButtonLink>
              }
            />
          </CardContent>
        ) : (
          <Table dense>
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
              {rows.map((po) => (
                <TableRow key={po.id}>
                  <TableCell className="font-medium">
                    <Link href={`/orders/${po.id}`} className="text-accent-ink hover:underline">
                      {po.poNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{po.supplierName ?? "—"}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1">
                      <PoStatusBadge status={po.status} />
                      {/* Only once a QuickBooks connection exists. Without one
                          the evidence is uniformly absent, and a column of
                          "not in the books" on every row would be noise that
                          reads as an outage. */}
                      {qbConnected && <QbEvidenceBadge qb={po.qb} />}
                    </span>
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
                        : "No date"}
                    {po.isLate && (
                      <Badge tone="negative" className="ml-2">
                        Late
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {pageCount > 1 && (
        <Pager
          page={current}
          pageCount={pageCount}
          from={start + 1}
          to={start + rows.length}
          total={matched}
          pageHref={(next) => hrefFor({ poPage: next })}
          label="Purchase order pages"
        />
      )}
    </Card>
  );
}
