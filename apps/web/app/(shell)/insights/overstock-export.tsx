"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import { formatRunRate } from "@/lib/money";
import type { OverstockRow } from "@/lib/data/insights";

/**
 * Export controls for the "over-bought" table. Client-side because ExportBar
 * builds the file in the browser; the rows are every overstocked line the server
 * ranked, so the download is the full list rather than the page you can see.
 *
 * Capital frozen is a cost figure and rides the money-blind gate — dropped from
 * the columns entirely for a member without view_costs, so the file never
 * carries a masked cell. The other columns are units and cover, not money, so
 * they stay for every role.
 */

/** Days-cover cell: whole days, or a dash when there is no rate to measure. */
const coverCell = (days: number | null): string => (days == null ? "—" : `${Math.round(days)}d`);

/** Exported for tests: money-blind members get no capital-frozen column. */
export function overstockExportColumns(
  canViewCosts: boolean,
  currency: string
): ExportColumn<OverstockRow>[] {
  return [
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "Class", cell: (r) => r.abc ?? "" },
    { header: "On hand", cell: (r) => r.onHandUnits },
    { header: "Sells/day", cell: (r) => formatRunRate(r.runRatePerDay) },
    { header: "Cover days", cell: (r) => coverCell(r.coverDays) },
    { header: "Excess units", cell: (r) => r.excessUnits },
    ...(canViewCosts
      ? ([{ header: `Capital frozen (${currency})`, cell: (r) => r.excessValueKes }] satisfies ExportColumn<OverstockRow>[])
      : []),
  ];
}

export function OverstockExportBar({
  rows,
  canViewCosts,
}: {
  /** Every overstocked row — the size of the file, not the paged table. */
  rows: OverstockRow[];
  canViewCosts: boolean;
}) {
  const currency = useCurrency();
  return (
    <ExportBar
      rows={rows}
      columns={overstockExportColumns(canViewCosts, currency)}
      filename="over-bought"
      size="sm"
    />
  );
}
