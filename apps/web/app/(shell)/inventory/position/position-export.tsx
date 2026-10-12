"use client";

import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import type { PositionRow, PositionWindow } from "@/lib/inventory/position";
import { exportInventoryPosition } from "./actions";

export const positionColumns: ExportColumn<PositionRow>[] = [
  { header: "Product", cell: r => r.title }, { header: "SKU", cell: r => r.sku },
  { header: "ABC", cell: r => r.abc ?? "Unrated" }, { header: "Supplier", cell: r => r.supplier ?? "" },
  { header: "Opening units (shop)", cell: r => r.opening },
  { header: "Opening basis", cell: r => r.openingEstimated ? "Estimated: current + sold; receipts/transfers excluded" : `Snapshot ${r.openingDate}` },
  { header: "Sold units", cell: r => r.soldUnits }, { header: "Current units (shop)", cell: r => r.onHand },
  { header: "Inbound units (shop)", cell: r => r.inbound },
  { header: "Observed days", cell: r => r.observedDays }, { header: "Observed in-stock days", cell: r => r.inStockDays },
  { header: "Confirmed out days", cell: r => r.stockoutDays }, { header: "Rate denominator days", cell: r => r.effectiveDays },
  { header: "Adjusted sales/day", cell: r => Number(r.salesPerDay.toFixed(3)) },
  { header: "Cover days at window rate (shop)", cell: r => r.coverDays == null ? null : Number(r.coverDays.toFixed(1)) },
];

export function PositionExport({ windowDays, search, count, period }: { windowDays: PositionWindow; search: string; count: number; period: string }) {
  return <ExportBar loadRows={() => exportInventoryPosition(windowDays, search)} count={count}
    columns={positionColumns} filename={`inventory-position-${windowDays}d`}
    document={{ title: "Inventory position", subtitle: `${period} · ${count} matching products`,
      footNote: "Shop-wide sellable stock. Rate = sold units / (window minus confirmed out days), with a 3–7 day minimum for thin histories. Unknown days are not confirmed in stock. Opening estimates exclude receipts and transfers." }} />;
}
