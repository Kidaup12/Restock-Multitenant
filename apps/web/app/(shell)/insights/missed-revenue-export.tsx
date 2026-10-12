"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import type { MissedCulprit } from "@/lib/data/insights";

/**
 * CSV export for the "Worst offenders" table — paired with the section's
 * existing branded ExportPdfButton the way every other Insights table pairs
 * a CSV export beside its PDF one. Missed revenue is a sales estimate, not a
 * cost figure, so it carries no money-blind gate.
 */
export function missedRevenueExportColumns(currency: string): ExportColumn<MissedCulprit>[] {
  return [
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "Class", cell: (r) => r.abc ?? "" },
    { header: "Empty days", cell: (r) => r.emptyDays },
    { header: "Units missed (est.)", cell: (r) => r.unitsMissed },
    { header: `Missed (${currency})`, cell: (r) => r.missedRevenueKes },
  ];
}

export function MissedRevenueExportBar({ rows }: { rows: MissedCulprit[] }) {
  const currency = useCurrency();
  return (
    <ExportBar
      rows={rows}
      columns={missedRevenueExportColumns(currency)}
      filename="missed-revenue"
      size="sm"
    />
  );
}
