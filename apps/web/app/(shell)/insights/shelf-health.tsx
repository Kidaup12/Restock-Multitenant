import Link from "next/link";
import { getInsightsOverview } from "@/lib/data/insights";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatMoney, formatNumber } from "@/lib/money";
import { cols } from "@/lib/export/print-pdf";
import { ExportPdfButton } from "./export-pdf-button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CashAsleepExportBar } from "./cash-asleep-export";

/** Day and month, from the stored UTC date — a date-keyed row must not shift for
 *  a reader west of UTC. */
const dayLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export async function ShelfHealth({
  tenantId,
  canViewCosts,
  currency,
}: {
  tenantId: string;
  canViewCosts: boolean;
  currency: string;
}) {
  const overview = await getInsightsOverview(tenantId, { canViewCosts });
  const { stockouts, deadStock, shelfRows, cashRows, cashTotalKes } = overview;
  // Every idle row (the CSV is the whole list, not the paged table), aliased so
  // it doesn't collide with the PDF's on-screen `cashExport` matrix below.
  const cashExportRows = overview.cashExport;

  if (stockouts.trackedProducts === 0) {
    return (
      <EmptyState
        title="No products tracked yet"
        description="Connect your shop or import a catalogue and this fills in overnight."
      />
    );
  }

  const missedPerDay = shelfRows.reduce((sum, r) => sum + r.missedSalesKes, 0);

  // Export tables mirror the on-screen columns and honour the same cost
  // redaction — a money-blind caller's rows never carry a cash figure. Rebuilt
  // from the same rows the tables render, so the PDF can't drift from the screen.
  const shelfExport = {
    columns: cols(["Product", "SKU", "Normally sells/day", "Missing/day", "Last sold"], [2, 3]),
    rows: shelfRows.map((r) => [
      r.title,
      r.sku,
      r.runRatePerDay.toFixed(1),
      formatMoney(r.missedSalesKes, currency),
      r.lastSoldAt ? dayLabel(r.lastSoldAt) : "never",
    ]),
  };
  const cashHeaders = ["Product", "SKU", "Why", "On hand", "Cover"];
  const cashExport = {
    columns: cols(canViewCosts ? [...cashHeaders, `Cash tied up`] : cashHeaders, [3, 4, 5]),
    rows: cashRows.map((r) => [
      r.title,
      r.sku,
      r.reason === "not_selling" ? "Not selling" : "Way too much",
      formatNumber(r.onHandUnits),
      r.coverDays == null ? "—" : `${Math.round(r.coverDays)}d`,
      ...(canViewCosts
        ? [r.costKnown && r.cashKes != null ? formatMoney(r.cashKes, currency) : "—"]
        : []),
    ]),
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Empty right now"
          value={`${stockouts.ratePct}%`}
          valueTone={stockouts.skus > 0 ? "negative" : "positive"}
          delta={{
            label: `${formatNumber(stockouts.skus)} of ${formatNumber(stockouts.trackedProducts)} products`,
            tone: stockouts.skus > 0 ? "negative" : "positive",
          }}
        />
        <StatTile
          label="Sales going missing"
          value={<CostValue amount={missedPerDay} compact />}
          valueTone={(missedPerDay ?? 0) > 0 ? "negative" : "default"}
          delta={{ label: "a day, while the shelf is empty", tone: "negative" }}
        />
        <StatTile
          label="Cash not moving"
          value={<CostValue amount={cashTotalKes} canViewCosts={canViewCosts} compact />}
          valueTone={canViewCosts && deadStock.skus > 0 ? "warning" : "default"}
          delta={{
            label: `${formatNumber(deadStock.skus)} products, ${deadStock.windowDays}+ days unsold`,
            tone: deadStock.skus > 0 ? "negative" : "positive",
          }}
        />
      </div>

      <Card data-tour="insights-shelves">
        <CardHeader
          title="Empty shelves right now"
          subtitle="Ranked by what they normally sell"
          action={
            shelfRows.length > 0 ? (
              <div className="flex items-center gap-2">
                <ExportPdfButton
                  title="Empty shelves"
                  subtitle="Ranked by what they normally sell"
                  columns={shelfExport.columns}
                  rows={shelfExport.rows}
                />
                <Link
                  href="/plan"
                  className="flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
                >
                  Plan a restock
                </Link>
              </div>
            ) : undefined
          }
        />
        <CardContent>
          {shelfRows.length === 0 ? (
            <EmptyState
              title="Nothing is out of stock"
              description="Every tracked product has something on the shelf. This is the number to keep at zero."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead numeric>Normally sells</TableHead>
                <TableHead numeric>Missing per day</TableHead>
                <TableHead numeric>Last sold</TableHead>
              </TableHeader>
              <TableBody>
                {shelfRows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <div className="font-medium text-ink">{row.title}</div>
                      <div className="text-xs text-ink-muted">{row.sku}</div>
                    </TableCell>
                    <TableCell numeric>{row.runRatePerDay.toFixed(1)}/day</TableCell>
                    <TableCell numeric>
                      <CostValue amount={row.missedSalesKes} />
                    </TableCell>
                    <TableCell numeric>
                      {row.lastSoldAt ? dayLabel(row.lastSoldAt) : "never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-tour="insights-cash">
        <CardHeader
          title="Cash asleep on the shelf"
          subtitle="Stock that isn't turning — money you could be spending on what sells"
          action={
            <div className="flex items-center gap-3">
              {/* The CSV is every idle row, not the paged table above — offered
                  wherever the list is, gated to any authenticated member (the
                  cost column drops for a money-blind one). */}
              {cashExportRows.length > 0 && (
                <CashAsleepExportBar rows={cashExportRows} canViewCosts={canViewCosts} />
              )}
              {cashRows.length > 0 && (
                <ExportPdfButton
                  title="Cash asleep on the shelf"
                  subtitle="Stock that isn't turning"
                  columns={cashExport.columns}
                  rows={cashExport.rows}
                />
              )}
              <CostValue
                amount={cashTotalKes}
                canViewCosts={canViewCosts}
                compact
                className="font-mono text-lg"
              />
            </div>
          }
        />
        <CardContent>
          {cashRows.length === 0 ? (
            <EmptyState
              title="No cash asleep"
              description={`Nothing has sat unsold for ${deadStock.windowDays} days, and nothing is carrying more than ${overview.overstockCoverDays} days of cover.`}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead>Why</TableHead>
                <TableHead numeric>On hand</TableHead>
                <TableHead numeric>Cover</TableHead>
                <TableHead numeric>Cash tied up</TableHead>
              </TableHeader>
              <TableBody>
                {cashRows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <div className="font-medium text-ink">{row.title}</div>
                      <div className="text-xs text-ink-muted">{row.sku}</div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={row.reason === "not_selling" ? "negative" : "warning"}>
                        {row.reason === "not_selling" ? "Not selling" : "Way too much"}
                      </Badge>
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                    <TableCell numeric>
                      {row.coverDays == null ? (
                        <span title="No sales, so there is no cover to measure">—</span>
                      ) : (
                        `${Math.round(row.coverDays)}d`
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {row.costKnown ? (
                        <CostValue amount={row.cashKes} canViewCosts={canViewCosts} compact />
                      ) : (
                        <span title="No cost recorded for this product">—</span>
                      )}
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
