"use client";
import type { TimelineEvent } from "@/lib/data/product-timeline";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";

const columns: ExportColumn<TimelineEvent>[] = [
  { header: "Date", cell: e => e.at },
  { header: "Event", cell: e => e.label },
  { header: "Units", cell: e => e.qty },
  { header: "Source", cell: e => e.actor },
  { header: "Detail", cell: e => e.detail },
];
export function HistoryExport({ sku, events }: { sku: string; events: TimelineEvent[] }) {
  return <ExportBar rows={events} columns={columns} filename={`${sku || "product"}-history`} />;
}
