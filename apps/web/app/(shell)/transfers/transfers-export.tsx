"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import type { TransferLine } from "@/lib/data/transfers";

/**
 * The pick list leaving the app. The store is read-only to Shopify, so this CSV
 * (or the printed sheet) IS the transfer: it's what the person moving boxes
 * carries. Rows come straight from the table, already cost-redacted upstream.
 */

/** Exported for tests: money-blind members get no value column. */
export function transferExportColumns(
  canViewCosts: boolean,
  currency: string
): ExportColumn<TransferLine>[] {
  return [
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "To", cell: (r) => r.toLocationName },
    { header: "Move", cell: (r) => r.qty },
    { header: "Sells/day", cell: (r) => r.toRunRate.toFixed(2) },
    { header: "Cover before", cell: (r) => r.toDaysCoverBefore },
    { header: "Cover after", cell: (r) => r.toDaysCoverAfter },
    ...(canViewCosts
      ? ([{ header: `Value (${currency})`, cell: (r) => r.valueKes }] satisfies ExportColumn<TransferLine>[])
      : []),
  ];
}

export function TransfersExportBar({
  rows,
  canViewCosts,
  fromLocationName,
  coverDays,
}: {
  rows: TransferLine[];
  canViewCosts: boolean;
  fromLocationName: string;
  coverDays: number;
}) {
  const currency = useCurrency();
  const units = rows.reduce((sum, r) => sum + r.qty, 0);
  return (
    <ExportBar
      rows={rows}
      columns={transferExportColumns(canViewCosts, currency)}
      filename="transfer-plan"
      document={{
        title: `Transfer plan — out of ${fromLocationName}`,
        subtitle: `${units} units across ${rows.length} lines, levelled to ${coverDays} days of cover`,
      }}
    />
  );
}
