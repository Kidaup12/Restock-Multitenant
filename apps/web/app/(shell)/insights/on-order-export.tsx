"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import type { OnOrderRow } from "@/lib/data/insights";

/**
 * Export controls for the "on the way" table. Client-side because ExportBar
 * builds the file in the browser; the rows are every inbound line the server
 * ranked by ETA, so the download is the full list rather than the page you can
 * see.
 *
 * Value in transit is a cost figure and rides the money-blind gate — dropped
 * from the columns entirely for a member without view_costs, so the file never
 * carries a masked cell. Units, ETA, lead and supplier are not money, so they
 * stay for every role.
 */

/** ETA cell: day and month from the stored UTC date, or a dash when unknown. */
const etaCell = (d: Date | null): string =>
  d == null ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Exported for tests: money-blind members get no value-in-transit column. */
export function onOrderExportColumns(
  canViewCosts: boolean,
  currency: string
): ExportColumn<OnOrderRow>[] {
  return [
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "Class", cell: (r) => r.abc ?? "" },
    { header: "Stock now", cell: (r) => r.onHandUnits },
    { header: "On the way", cell: (r) => r.onOrderUnits },
    { header: "ETA", cell: (r) => etaCell(r.expectedArrivalAt) },
    { header: "Lead days", cell: (r) => r.leadDays },
    { header: "Supplier", cell: (r) => r.supplierName ?? "" },
    ...(canViewCosts
      ? ([{ header: `Value in transit (${currency})`, cell: (r) => r.valueKes }] satisfies ExportColumn<OnOrderRow>[])
      : []),
  ];
}

export function OnOrderExportBar({
  rows,
  canViewCosts,
}: {
  /** Every inbound row — the size of the file, not the paged table. */
  rows: OnOrderRow[];
  canViewCosts: boolean;
}) {
  const currency = useCurrency();
  return (
    <ExportBar
      rows={rows}
      columns={onOrderExportColumns(canViewCosts, currency)}
      filename="on-the-way"
      size="sm"
    />
  );
}
