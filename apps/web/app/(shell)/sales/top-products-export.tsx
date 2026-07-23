"use client";

import type { TopProduct } from "@/lib/data/sales";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";

/**
 * Export controls for the top-products table. Client-side because ExportBar
 * builds files in the browser; the server table hands it the same rows it
 * renders. Revenue is a sales figure — visible to every role — so there are
 * no gated columns here.
 */

const columns: ExportColumn<TopProduct>[] = [
  { header: "Product", cell: (r) => r.title },
  { header: "SKU", cell: (r) => r.sku },
  { header: "Units", cell: (r) => r.unitsSold },
  { header: "Revenue (KES)", cell: (r) => r.revenueKes },
  { header: "Run rate (units/day)", cell: (r) => Math.round(r.runRatePerDay * 10) / 10 },
];

export function TopProductsExportBar({ rows }: { rows: TopProduct[] }) {
  return (
    <ExportBar
      rows={rows}
      columns={columns}
      filename="sales-top-products"
      document={{
        title: "Top products, 30 days",
        subtitle: `Ranked by revenue, all channels · ${rows.length} products`,
      }}
    />
  );
}
