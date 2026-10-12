"use client";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import type { InventoryPeriod, InventoryPeriodDetail } from "@/lib/reports/period-inventory";
export function PurchasingHistoryExport({ rows, canViewCosts, currency }: {
    rows: InventoryPeriod[];
    canViewCosts: boolean;
    currency: string;
}) {
    const columns: ExportColumn<InventoryPeriod>[] = [{ header: "From", cell: r => r.from }, { header: "Through", cell: r => r.through }, { header: "Snapshot days", cell: r => r.snapshotDays }, { header: "Ordered units", cell: r => r.orderedUnits }, { header: "Above recommendation units", cell: r => r.overorderUnits }, { header: "Dead SKUs", cell: r => r.deadCount }, { header: "Excess SKUs", cell: r => r.overstockCount }];
    columns.push({ header: "Days in selected period", cell: r => r.days }, { header: "Products observed at period end", cell: r => r.endObservedProducts }, { header: "Products in class lens", cell: r => r.eligibleProducts }, { header: "PO lines with saved recommendation", cell: r => r.comparisonLines }, { header: "PO lines without saved recommendation", cell: r => r.unmeasuredLines });
    if (canViewCosts)
        columns.push({ header: `Ordered cost (${currency})`, cell: r => r.orderedValueKes }, { header: `Above recommendation cost (${currency})`, cell: r => r.overorderValueKes }, { header: `Dead stock cost (${currency})`, cell: r => r.deadValueKes }, { header: `Excess cost (${currency})`, cell: r => r.overstockValueKes });
    type Detail = InventoryPeriodDetail & {
        from: string;
        through: string;
    };
    const detailColumns: ExportColumn<Detail>[] = [{ header: "From", cell: r => r.from }, { header: "Through", cell: r => r.through }, { header: "Product", cell: r => r.title }, { header: "SKU", cell: r => r.sku }, { header: "Measure", cell: r => r.kind }, { header: "Units", cell: r => r.units }];
    if (canViewCosts)
        detailColumns.push({ header: `Cost (${currency})`, cell: r => r.valueKes });
    return <div className="flex flex-wrap gap-6"><div><p className="mb-1 text-xs text-ink-muted">Weekly totals</p><ExportBar rows={rows} columns={columns} filename="weekly-purchasing" document={{ title: "Purchasing and stock by week", footNote: "Stock values use current catalogue costs; PO values use their saved line costs. Missing period-end observations and missing saved recommendations remain unmeasured." }}/></div><div><p className="mb-1 text-xs text-ink-muted">Product detail</p><ExportBar rows={rows.flatMap(r => r.details.map(d => ({ ...d, from: r.from, through: r.through })))} columns={detailColumns} filename="weekly-purchasing-products"/></div></div>;
}
