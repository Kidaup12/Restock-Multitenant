"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import type { CashExportRow } from "@/lib/data/insights";

/**
 * Export controls for the dedicated "Dead stock" section. Client-side because
 * ExportBar builds the file in the browser; the rows are every not-selling line
 * the server ranked (the on-screen table pages to a handful), so the download is
 * the full dead pile rather than the page you can see.
 *
 * Reuses the cash-asleep export row — the dead-stock section hands over
 * `cashExport` filtered to the "Not selling" pile, so the file and the table
 * read one list. Capital tied up is a cost figure and rides the money-blind
 * gate: dropped from the columns entirely for a member without view_costs, so
 * the file never carries a masked cell. The other columns are class and cover,
 * not money, so they stay for every role.
 */

/** Days-cover cell: whole days, or a dash when there is no rate to measure. */
const coverCell = (days: number | null): string => (days == null ? "—" : `${days}d`);

/** Exported for tests: money-blind members get no capital-tied-up column. */
export function deadStockExportColumns(
  canViewCosts: boolean,
  currency: string
): ExportColumn<CashExportRow>[] {
  return [
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "Vendor", cell: (r) => r.vendor ?? "" },
    { header: "Class", cell: (r) => r.abc ?? "" },
    { header: "Days cover", cell: (r) => coverCell(r.coverDays) },
    ...(canViewCosts
      ? ([{ header: `Capital tied up (${currency})`, cell: (r) => r.cashKes }] satisfies ExportColumn<CashExportRow>[])
      : []),
    { header: "Recommended action", cell: (r) => r.action },
  ];
}

export function DeadStockExportBar({
  rows,
  canViewCosts,
}: {
  /** Every not-selling row — the size of the file, not the paged table. */
  rows: CashExportRow[];
  canViewCosts: boolean;
}) {
  const currency = useCurrency();
  return (
    <ExportBar
      rows={rows}
      columns={deadStockExportColumns(canViewCosts, currency)}
      filename="dead-stock"
      size="sm"
    />
  );
}
