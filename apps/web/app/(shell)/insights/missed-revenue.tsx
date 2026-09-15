import { getMissedRevenue } from "@/lib/data/insights";
import type { AbcKey } from "@/lib/data/abc-lens";

import { AbcBadge } from "@/components/ui/abc-badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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

/**
 * "Sales missed to empty shelves" — what stockouts cost in sales over the range,
 * as a headline, a weekly trend, an A/B/C rollup and the worst culprits.
 *
 * The figure is a SALES estimate (a product's normal run rate × its price × the
 * days its shelf was empty), so it is shown to every role — no cost gate, and the
 * loader takes no canViewCosts. It IS an estimate and the caption says so: a
 * stockout's true lost demand is unknowable, and run-rate × empty-days is the
 * honest proxy — the same rate the buy list sizes on.
 *
 * The weekly bars mirror the stockout-trend chart's div-height style, drawn
 * against the biggest week so the shape reads at a glance.
 */

const weekLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const dateLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export async function MissedRevenueSection({
  tenantId,
  currency,
  weeks,
  abc,
}: {
  tenantId: string;
  currency: string;
  /** Weeks to cover, from the report's period. */
  weeks: number;
  /** The A/B/C lens from the URL — filters the whole section, like shelf health. */
  abc: AbcKey;
}) {
  const { totalMissedKes, totalEmptyProductDays, trend, byClass, culprits, trackingSince } =
    await getMissedRevenue(tenantId, { weeks, abc });

  // No loss in the window (or nothing tracked yet) → the good news, said plainly.
  // trackingSince is null when the nightly check has never run; a friendlier line
  // than an empty chart for a brand-new workspace.
  if (totalMissedKes === 0 || trend.length === 0) {
    return (
      <Card data-tour="insights-missed-revenue">
        <CardHeader title="Sales missed to empty shelves" />
        <CardContent>
          <EmptyState
            title={trackingSince ? "No stockout losses in this window — shelves stayed full." : "Not tracking yet"}
            description={
              trackingSince
                ? `Nothing on the shelf ran to zero across a week we could measure since ${dateLabel(trackingSince)}. This is the number to keep at nothing.`
                : "We record what's on the shelf once a night. Once a full week of that history is in, any sales an empty shelf cost show up here."
            }
          />
        </CardContent>
      </Card>
    );
  }

  // Bars drawn against the worst week, so the trend fills its own width.
  const peak = trend.reduce((m, p) => Math.max(m, p.missedRevenueKes), 0);

  // The PDF is the culprits table — the actionable cut. Revenue is a sales
  // figure, so nothing is redacted; the columns mirror the on-screen table.
  const pdf = {
    columns: cols(["Product", "Class", "Empty days", "~Units missed", "Missed"], [2, 3, 4]),
    rows: culprits.map((c) => [
      c.title,
      c.abc ?? "unrated",
      formatNumber(c.emptyDays),
      formatNumber(c.unitsMissed),
      formatMoney(c.missedRevenueKes, currency),
    ]),
  };

  return (
    <Card data-tour="insights-missed-revenue">
      <CardHeader
        title="Sales missed to empty shelves"
        subtitle="What stockouts cost in sales over the report window, worst products first"
        action={
          culprits.length > 0 ? (
            <ExportPdfButton
              title="Sales missed to empty shelves"
              subtitle="Worst products first"
              columns={pdf.columns}
              rows={pdf.rows}
              note="An estimate: a product's normal run rate × its price × the days its shelf was empty."
            />
          ) : undefined
        }
      />
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <StatTile
              label="Sales missed to empty shelves"
              value={formatMoney(totalMissedKes, currency, { compact: true })}
              valueTone={totalMissedKes > 0 ? "negative" : "positive"}
              delta={{
                label: `${formatNumber(totalEmptyProductDays)} product-days with nothing on the shelf`,
                tone: "negative",
              }}
            />
            {/* It IS an estimate — say so, so nobody reads it as booked loss. */}
            <p className="text-2xs text-ink-muted">
              An estimate. A stockout&rsquo;s true lost demand is unknowable, so this is a product&rsquo;s
              normal run rate × its price × the days its shelf sat empty — the same rate the buy list sizes on.
            </p>
          </div>
        </div>

        {/* Weekly trend — same div-height bar style as the stockout-trend chart. */}
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            Week by week
          </h3>
          <div className="flex h-32 items-end gap-2">
            {trend.map((point) => (
              <div key={point.weekStart.getTime()} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="font-mono text-2xs tabular-nums text-ink-muted">
                  {formatMoney(point.missedRevenueKes, currency, { compact: true })}
                </span>
                <div className="flex h-full w-full items-end">
                  <div
                    className="w-full rounded-t bg-accent"
                    style={{ height: `${peak > 0 ? Math.max(2, (point.missedRevenueKes / peak) * 100) : 2}%` }}
                    role="img"
                    aria-label={`Week of ${weekLabel(point.weekStart)}: ${formatMoney(point.missedRevenueKes, currency)} missed`}
                  />
                </div>
                <span className="text-2xs text-ink-muted">{weekLabel(point.weekStart)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* A/B/C rollup — where the loss concentrates. A dead A-line matters more
            than a hundred dead C-lines, so the class split is the part worth
            acting on. */}
        {byClass.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
              By class
            </h3>
            <Table>
              <TableHeader>
                <TableHead>Class</TableHead>
                <TableHead numeric>SKUs</TableHead>
                <TableHead numeric>Empty days</TableHead>
                <TableHead numeric>~Units missed</TableHead>
                <TableHead numeric>Missed</TableHead>
              </TableHeader>
              <TableBody>
                {byClass.map((row) => (
                  <TableRow key={row.cls}>
                    <TableCell>
                      <AbcBadge value={row.cls} unratedLabel="Unrated" />
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.skuCount)}</TableCell>
                    <TableCell numeric>{formatNumber(row.emptyDays)}</TableCell>
                    <TableCell numeric>{formatNumber(row.unitsMissed)}</TableCell>
                    <TableCell numeric>{formatMoney(row.missedRevenueKes, currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Top culprits — the products to fix first. */}
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            Worst offenders
          </h3>
          <Table>
            <TableHeader>
              <TableHead>Product</TableHead>
              <TableHead>Class</TableHead>
              <TableHead numeric>Empty days</TableHead>
              <TableHead numeric>~Units missed</TableHead>
              <TableHead numeric>Missed</TableHead>
            </TableHeader>
            <TableBody>
              {culprits.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell>
                    <div className="font-medium text-ink">{row.title}</div>
                    <div className="text-xs text-ink-muted">{row.sku}</div>
                  </TableCell>
                  <TableCell>
                    <AbcBadge value={row.abc} />
                  </TableCell>
                  <TableCell numeric>{formatNumber(row.emptyDays)}</TableCell>
                  <TableCell numeric>{formatNumber(row.unitsMissed)}</TableCell>
                  <TableCell numeric>{formatMoney(row.missedRevenueKes, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
