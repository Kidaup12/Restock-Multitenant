"use client";

import { useCurrency } from "@/components/currency-provider";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import type { CatalogueRow } from "@/lib/data/stock";
import type { UnsoldReason } from "@/lib/data/today";
import { UNSOLD_STATUS_LABELS } from "@/lib/inventory/unsold-labels";
export { UNSOLD_STATUS_LABELS } from "@/lib/inventory/unsold-labels";

export function unsoldExportColumns(canViewCosts: boolean, currency: string, reasons: Record<string, UnsoldReason>): ExportColumn<CatalogueRow>[] {
  return [
    { header: "SKU", cell: row => row.sku },
    { header: "Product", cell: row => row.title },
    { header: "Brand", cell: row => row.vendor ?? "" },
    { header: "ABC", cell: row => row.abc },
    { header: "Stock", cell: row => row.onHandUnits },
    { header: "Dead-stock status", cell: row => UNSOLD_STATUS_LABELS[reasons[row.productId] ?? "unknown_age"] },
    ...(canViewCosts ? [
      { header: `Unit cost (${currency})`, cell: (row: CatalogueRow) => row.costKes },
      { header: `Stock value at cost (${currency})`, cell: (row: CatalogueRow) => row.moneyAtRestKes },
    ] : []),
  ];
}

export function UnsoldStockExport({ rows, reasons, canViewCosts }: { rows: CatalogueRow[]; reasons: Record<string, UnsoldReason>; canViewCosts: boolean }) {
  const currency = useCurrency();
  return <ExportBar rows={rows} columns={unsoldExportColumns(canViewCosts, currency, reasons)} filename="unsold-stock"
    document={{ title: "Unsold stock", subtitle: "Currently stocked products with no recorded positive sales. Includes products in the new-product grace period.", footNote: "Some products may also qualify as dead stock. Do not add these totals together." }} />;
}
