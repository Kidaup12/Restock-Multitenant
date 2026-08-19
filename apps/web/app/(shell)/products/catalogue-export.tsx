"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import { formatMoney } from "@/lib/money";

/**
 * Export controls for the stock catalogue. Client-side because ExportBar
 * builds files in the browser; the server table hands it the same rows it
 * renders (already cost-redacted for money-blind members) plus the computed
 * status label, so the export always matches the table.
 */

export type CatalogueExportRow = {
  title: string;
  sku: string;
  onHandUnits: number;
  warehouseUnits: number;
  daysCover: number | null;
  status: string;
  costKes: number | null;
  stockValueKes: number | null;
};

/** Exported for tests: money-blind members get no cost columns. */
export function catalogueExportColumns(
  canViewCosts: boolean,
  currency: string
): ExportColumn<CatalogueExportRow>[] {
  return [
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "On hand", cell: (r) => r.onHandUnits },
    { header: "In warehouse", cell: (r) => r.warehouseUnits },
    { header: "Days cover", cell: (r) => r.daysCover },
    { header: "Status", cell: (r) => r.status },
    ...(canViewCosts
      ? ([
          { header: `Unit cost (${currency})`, cell: (r) => r.costKes },
          { header: `Stock value (${currency})`, cell: (r) => r.stockValueKes },
        ] satisfies ExportColumn<CatalogueExportRow>[])
      : []),
  ];
}

export function CatalogueExportBar({
  count,
  totalValueKes,
  loadRows,
  canViewCosts,
}: {
  /** Rows the reader's filters match — the size of the file, not of the page. */
  count: number;
  /** Σ stock value across those matched rows; null for a money-blind member. */
  totalValueKes: number | null;
  loadRows: () => Promise<CatalogueExportRow[]>;
  canViewCosts: boolean;
}) {
  const currency = useCurrency();
  return (
    <ExportBar
      loadRows={loadRows}
      count={count}
      columns={catalogueExportColumns(canViewCosts, currency)}
      filename="stock-catalogue"
      document={{
        title: "Stock catalogue",
        subtitle: `${count} products`,
        footNote:
          canViewCosts && totalValueKes != null
            ? `Stock value at cost: ${formatMoney(totalValueKes, currency)}`
            : undefined,
      }}
    />
  );
}
