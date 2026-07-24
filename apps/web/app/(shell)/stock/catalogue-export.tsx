"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";

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
  canViewCosts: boolean
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
          { header: "Unit cost (KES)", cell: (r) => r.costKes },
          { header: "Stock value (KES)", cell: (r) => r.stockValueKes },
        ] satisfies ExportColumn<CatalogueExportRow>[])
      : []),
  ];
}

export function CatalogueExportBar({
  rows,
  canViewCosts,
}: {
  rows: CatalogueExportRow[];
  canViewCosts: boolean;
}) {
  const totalValueKes = rows.reduce((sum, r) => sum + (r.stockValueKes ?? 0), 0);
  return (
    <ExportBar
      rows={rows}
      columns={catalogueExportColumns(canViewCosts)}
      filename="stock-catalogue"
      document={{
        title: "Stock catalogue",
        subtitle: `${rows.length} products`,
        footNote: canViewCosts
          ? `Stock value at cost: KES ${Math.round(totalValueKes).toLocaleString("en-KE")}`
          : undefined,
      }}
    />
  );
}
