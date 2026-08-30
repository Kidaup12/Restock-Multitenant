"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import type { DeadStockExportRow } from "@/lib/data/today";

/**
 * Export controls for the dashboard's dead-stock tab. Client-side because
 * ExportBar builds the file in the browser; the rows are the whole dead pile the
 * server already computed (capped only for the on-screen table), so the download
 * is the full list rather than the page you can see.
 *
 * Value at cost is a cost figure and rides the money-blind gate — it is dropped
 * from the columns entirely for a member without view_costs, so the file never
 * carries a masked cell. Value at retail is a sales figure and stays for every
 * role.
 */

/** ISO date (UTC) — a date-keyed cell must not shift for a reader west of UTC,
 *  and yyyy-mm-dd is the one form a spreadsheet reliably reads as a date. */
const isoDay = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "never");

/** Exported for tests: money-blind members get no value-at-cost column. */
export function deadStockExportColumns(
  canViewCosts: boolean,
  currency: string
): ExportColumn<DeadStockExportRow>[] {
  return [
    { header: "SKU", cell: (r) => r.sku },
    { header: "Product", cell: (r) => r.title },
    { header: "Brand", cell: (r) => r.vendor ?? "" },
    { header: "On hand", cell: (r) => r.onHandUnits },
    { header: "Last sale", cell: (r) => isoDay(r.lastSaleAt) },
    { header: "Days since last sale", cell: (r) => r.daysSinceLastSale },
    ...(canViewCosts
      ? ([{ header: `Value at cost (${currency})`, cell: (r) => r.valueAtCostKes }] satisfies ExportColumn<DeadStockExportRow>[])
      : []),
    { header: `Value at retail (${currency})`, cell: (r) => r.valueAtRetailKes },
  ];
}

export function DeadStockExportBar({
  rows,
  canViewCosts,
}: {
  /** The whole dead pile — the size of the file, not the capped tab. */
  rows: DeadStockExportRow[];
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
