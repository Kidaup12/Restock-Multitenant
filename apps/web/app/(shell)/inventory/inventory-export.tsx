"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { useCurrency } from "@/components/currency-provider";
import { exportInventoryAction } from "./actions";
import type { LocationsQuery } from "@/lib/data/stock";

/**
 * Export controls for stock by location.
 *
 * This is the screen someone takes to a stock count, and it was the one screen
 * with no way to get the numbers out of the browser. The location leads each
 * row: a file of SKUs with no branch on them is unusable the moment a shop has
 * more than one.
 */

export type InventoryExportRow = {
  location: string;
  title: string;
  sku: string;
  onHand: number;
  daysCover: number | null;
  onOrderUnits: number;
  /** Null for a member who cannot view costs — the redaction happens in the
   *  getter, so the column simply arrives empty rather than being dropped. */
  valueKes: number | null;
};

/** Exported for tests: money-blind members get no value column. */
export function inventoryExportColumns(
  canViewCosts: boolean,
  currency: string,
): ExportColumn<InventoryExportRow>[] {
  return [
    { header: "Branch", cell: (r) => r.location },
    { header: "Product", cell: (r) => r.title },
    { header: "SKU", cell: (r) => r.sku },
    { header: "On hand", cell: (r) => r.onHand },
    { header: "Days cover (shop)", cell: (r) => r.daysCover },
    { header: "En route (shop)", cell: (r) => r.onOrderUnits },
    ...(canViewCosts
      ? ([{ header: `Value (${currency})`, cell: (r) => r.valueKes }] satisfies ExportColumn<InventoryExportRow>[])
      : []),
  ];
}

/** Takes the QUERY, not a loader. The screen that renders this is a server
 *  component, and a closure cannot cross that boundary — passing one renders
 *  the whole page as "Something went wrong", which no test that stops at the
 *  model would ever see. The query is plain data; the action is a server
 *  action, so both travel. */
export function InventoryExportBar({
  count,
  query,
  canViewCosts,
}: {
  count: number;
  query: LocationsQuery;
  canViewCosts: boolean;
}) {
  const currency = useCurrency();
  return (
    <ExportBar
      loadRows={() => exportInventoryAction(query)}
      count={count}
      columns={inventoryExportColumns(canViewCosts, currency)}
      filename="stock-by-branch"
      document={{ title: "Stock by branch", subtitle: `${count} line${count === 1 ? "" : "s"}` }}
    />
  );
}
