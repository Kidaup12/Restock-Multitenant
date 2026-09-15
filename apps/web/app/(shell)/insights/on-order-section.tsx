import { getOnOrder } from "@/lib/data/insights";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { formatMoney, formatNumber } from "@/lib/money";
import { cols } from "@/lib/export/print-pdf";
import { ExportPdfButton } from "./export-pdf-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OnOrderExportBar } from "./on-order-export";

/**
 * "On the way" — what is already inbound, so an owner does not double-order.
 *
 * The loader reads the canonical inbound rules (effective on-order, earliest
 * ETA) from the stock catalogue and ranks by soonest arrival, unknown ETAs
 * last — this is a presentation of that, never a second on-order calculation.
 *
 * Value in transit is a cost figure and carries the money-blind redaction: the
 * column is dropped from the PDF matrix and the CSV, and the value tile masks,
 * for a member without view_costs. Units on the way is not money and stays for
 * every role.
 */

/** Day and month from the stored UTC date — a dated row must not shift for a
 *  reader west of UTC. */
const etaLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export async function OnOrderSection({
  tenantId,
  currency,
  canViewCosts,
}: {
  tenantId: string;
  currency: string;
  canViewCosts: boolean;
}) {
  const { rows, totalUnits, totalValueKes } = await getOnOrder(tenantId, { canViewCosts });

  // The PDF mirrors the on-screen columns and honours the same cost redaction —
  // a money-blind caller's rows never carry a value figure. Rebuilt from the
  // same rows the table renders, so the PDF can't drift from the screen.
  const headers = ["Product", "SKU", "Class", "On the way", "ETA", "Lead days", "Supplier"];
  const pdf = {
    columns: cols(canViewCosts ? [...headers, "Value in transit"] : headers, [3, 5, 7]),
    rows: rows.map((r) => [
      r.title,
      r.sku,
      r.abc ?? "—",
      formatNumber(r.onOrderUnits),
      r.expectedArrivalAt ? etaLabel(r.expectedArrivalAt) : "—",
      `${r.leadDays}d`,
      r.supplierName ?? "—",
      ...(canViewCosts
        ? [r.valueKes != null ? formatMoney(r.valueKes, currency) : "—"]
        : []),
    ]),
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatTile
          label="Units on the way"
          value={formatNumber(totalUnits)}
          delta={{ label: "already inbound — don't double-order", tone: "neutral" }}
        />
        {canViewCosts && (
          <StatTile
            label="Value in transit"
            value={<CostValue amount={totalValueKes} canViewCosts={canViewCosts} compact />}
            delta={{ label: "capital already committed", tone: "neutral" }}
          />
        )}
      </div>

      <Card data-tour="insights-on-order">
        <CardHeader
          title="On the way"
          subtitle="Stock already ordered and inbound, soonest arrival first"
          action={
            rows.length > 0 ? (
              <div className="flex items-center gap-3">
                <OnOrderExportBar rows={rows} canViewCosts={canViewCosts} />
                <ExportPdfButton
                  title="On the way"
                  subtitle="Stock already ordered and inbound"
                  columns={pdf.columns}
                  rows={pdf.rows}
                />
              </div>
            ) : undefined
          }
        />
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing on the way"
              description="Nothing on the way right now."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead>Class</TableHead>
                <TableHead numeric>On the way</TableHead>
                <TableHead>ETA</TableHead>
                <TableHead numeric>Lead days</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead numeric>Value in transit</TableHead>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <div className="font-medium text-ink">{row.title}</div>
                      <div className="text-xs text-ink-muted">{row.sku}</div>
                    </TableCell>
                    <TableCell>
                      {row.abc ? (
                        <Badge tone="neutral">{row.abc}</Badge>
                      ) : (
                        <span className="text-xs text-ink-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.onOrderUnits)}</TableCell>
                    <TableCell>
                      {row.expectedArrivalAt ? (
                        etaLabel(row.expectedArrivalAt)
                      ) : (
                        <span title="No expected arrival date recorded" className="text-ink-faint">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell numeric>{row.leadDays}d</TableCell>
                    <TableCell>{row.supplierName ?? <span className="text-ink-faint">—</span>}</TableCell>
                    <TableCell numeric>
                      <CostValue amount={row.valueKes} canViewCosts={canViewCosts} compact />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
