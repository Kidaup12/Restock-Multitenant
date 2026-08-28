"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import type { CashExportRow } from "@/lib/data/insights";

/**
 * Export controls for the insights "cash asleep" table. Client-side because
 * ExportBar builds the file in the browser; the rows are every idle row the
 * server ranked (the on-screen table pages to a handful), so the download is the
 * full list rather than the page you can see.
 *
 * Frozen cash is a cost figure and rides the money-blind gate — dropped from the
 * columns entirely for a member without view_costs, so the file never carries a
 * masked cell. The other columns are derived, not money, so they stay for every
 * role.
 */

/** Days-cover cell: whole days, or a dash when there is no rate to measure. */
const coverCell = (days: number | null): string => (days == null ? "—" : `${days}d`);

/** Exported for tests: money-blind members get no frozen-cash column. */
export function cashExportColumns(
  canViewCosts: boolean,
  currency: string
): ExportColumn<CashExportRow>[] {
  return [
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "Vendor", cell: (r) => r.vendor ?? "" },
    { header: "Days cover", cell: (r) => coverCell(r.coverDays) },
    ...(canViewCosts
      ? ([{ header: `Frozen cash (${currency})`, cell: (r) => r.cashKes }] satisfies ExportColumn<CashExportRow>[])
      : []),
    { header: "Risk", cell: (r) => r.risk },
    { header: "Recommended action", cell: (r) => r.action },
  ];
}

export function CashAsleepExportBar({
  rows,
  canViewCosts,
}: {
  /** Every idle row — the size of the file, not the paged table. */
  rows: CashExportRow[];
  canViewCosts: boolean;
}) {
  const currency = useCurrency();
  return (
    <ExportBar
      rows={rows}
      columns={cashExportColumns(canViewCosts, currency)}
      filename="cash-asleep"
      size="sm"
    />
  );
}
