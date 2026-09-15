import { getOverstock } from "@/lib/data/insights";
import { type AbcKey } from "@/lib/data/abc-lens";

import { AbcBadge } from "@/components/ui/abc-badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { formatMoney, formatNumber, formatRunRate } from "@/lib/money";
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
import { OverstockExportBar } from "./overstock-export";

/**
 * "Over-bought" — the EXCESS above a healthy cover, in units and in cash.
 *
 * The cash-asleep table already shows total capital at rest; this isolates the
 * part you over-ordered — the units you could have kept liquid — rather than the
 * whole pile. The loader ranks it (by frozen capital when costs are visible, by
 * excess units when they are not) and honours the ABC lens, so what the table,
 * the CSV and the PDF show is one filtered, one-ranked list.
 *
 * Capital frozen is a cost figure and carries the money-blind redaction: the
 * column is dropped from the PDF matrix and the CSV, and the tile masks, for a
 * member without view_costs.
 */
export async function OverstockSection({
  tenantId,
  currency,
  canViewCosts,
  abc,
}: {
  tenantId: string;
  currency: string;
  canViewCosts: boolean;
  /** The A/B/C lens from the URL. Filters the table and both exports. */
  abc: AbcKey;
}) {
  const { rows, totalExcessKes, thresholdDays } = await getOverstock(tenantId, {
    canViewCosts,
    abc,
  });

  // The PDF mirrors the on-screen columns and honours the same cost redaction —
  // a money-blind caller's rows never carry a capital figure. Rebuilt from the
  // same rows the table renders, so the PDF can't drift from the screen.
  const headers = ["Product", "SKU", "Class", "On hand", "Sells/day", "Cover days", "Excess units"];
  const pdf = {
    columns: cols(canViewCosts ? [...headers, "Capital frozen"] : headers, [3, 4, 5, 6, 7]),
    rows: rows.map((r) => [
      r.title,
      r.sku,
      r.abc ?? "—",
      formatNumber(r.onHandUnits),
      formatRunRate(r.runRatePerDay),
      r.coverDays == null ? "—" : `${Math.round(r.coverDays)}d`,
      formatNumber(r.excessUnits),
      ...(canViewCosts
        ? [r.excessValueKes != null ? formatMoney(r.excessValueKes, currency) : "—"]
        : []),
    ]),
  };

  return (
    <div className="space-y-4">
      {canViewCosts && (
        <div className="grid grid-cols-1 sm:max-w-xs">
          <StatTile
            label="Capital frozen in excess"
            value={<CostValue amount={totalExcessKes} canViewCosts={canViewCosts} compact />}
            valueTone={(totalExcessKes ?? 0) > 0 ? "warning" : "default"}
            delta={{
              label: `above ${thresholdDays} days of cover`,
              tone: (totalExcessKes ?? 0) > 0 ? "negative" : "positive",
            }}
          />
        </div>
      )}

      <Card data-tour="insights-overstock">
        <CardHeader
          title="Over-bought"
          subtitle={`Stock above ${thresholdDays} days of cover — cash you could have kept liquid`}
          action={
            rows.length > 0 ? (
              <div className="flex items-center gap-3">
                <OverstockExportBar rows={rows} canViewCosts={canViewCosts} />
                <ExportPdfButton
                  title="Over-bought"
                  subtitle={`Stock above ${thresholdDays} days of cover`}
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
              title="Nothing overstocked"
              description="Nothing overstocked — your cover levels are healthy."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead>Class</TableHead>
                <TableHead numeric>On hand</TableHead>
                <TableHead numeric>Sells/day</TableHead>
                <TableHead numeric>Cover days</TableHead>
                <TableHead numeric>Excess units</TableHead>
                <TableHead numeric>Capital frozen</TableHead>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <div className="font-medium text-ink">{row.title}</div>
                      <div className="text-xs text-ink-muted">{row.sku}</div>
                    </TableCell>
                    <TableCell>
                      <AbcBadge value={row.abc} />
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                    <TableCell numeric>{formatRunRate(row.runRatePerDay)}</TableCell>
                    <TableCell numeric>
                      {row.coverDays == null ? (
                        <span title="No sales, so there is no cover to measure">—</span>
                      ) : (
                        `${Math.round(row.coverDays)}d`
                      )}
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.excessUnits)}</TableCell>
                    <TableCell numeric>
                      <CostValue amount={row.excessValueKes} canViewCosts={canViewCosts} compact />
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
