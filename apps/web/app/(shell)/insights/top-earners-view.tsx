"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import type { TopProduct } from "@/lib/data/sales";

/**
 * Best earners, filterable by ABC class.
 *
 * The class chips answer the question a report is for: are the products the
 * shop leans on — its A-class — actually the ones bringing the money in? A
 * top-ten by raw revenue cannot show that; splitting it by class can.
 *
 * Filtering is client-side over the rows already fetched, so a chip is instant
 * and the export always matches what is on screen.
 */

const CLASS_CHIPS = [
  { key: "all", label: "All classes" },
  { key: "A", label: "Best sellers" },
  { key: "B", label: "Steady" },
  { key: "C", label: "Slow movers" },
] as const;

type ClassKey = (typeof CLASS_CHIPS)[number]["key"];

const SHOWN = 10;

const columns = (currency: string): ExportColumn<TopProduct>[] => [
  { header: "Product", cell: (r) => r.title },
  { header: "SKU", cell: (r) => r.sku },
  { header: "ABC", cell: (r) => r.abc ?? "" },
  { header: "Units", cell: (r) => r.unitsSold },
  { header: `Revenue (${currency})`, cell: (r) => r.revenueKes },
  { header: "Run rate (units/day)", cell: (r) => Math.round(r.runRate * 10) / 10 },
];

export function TopEarnersView({ rows, currency }: { rows: TopProduct[]; currency: string }) {
  const [cls, setCls] = useState<ClassKey>("all");
  const ctxCurrency = useCurrency();

  const filtered = useMemo(
    () => (cls === "all" ? rows : rows.filter((r) => r.abc === cls)).slice(0, SHOWN),
    [rows, cls],
  );

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader title="Top earners, 30 days" />
        <CardContent>
          <EmptyState
            title="No sales in the last 30 days"
            description="Your best sellers rank here once sales land."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Top earners, 30 days"
        subtitle="Ranked by revenue, all channels"
        action={
          <ExportBar
            rows={filtered}
            columns={columns(ctxCurrency)}
            filename="top-earners"
            document={{
              title: "Top earners, 30 days",
              subtitle: `Ranked by revenue · ${cls === "all" ? "all classes" : `class ${cls}`} · ${filtered.length} products`,
            }}
          />
        }
      />
      <div className="flex flex-wrap gap-1.5 px-4 pb-1">
        {CLASS_CHIPS.map((chip) => {
          const on = cls === chip.key;
          const count =
            chip.key === "all" ? rows.length : rows.filter((r) => r.abc === chip.key).length;
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setCls(chip.key)}
              aria-pressed={on}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors",
                on
                  ? "border-accent-200 bg-accent-soft text-accent-ink"
                  : "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              {chip.label}
              <span className="rounded-xs bg-surface-2/70 px-1.5 font-mono tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-1 pb-2">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">
            No products in this class earned anything in the last 30 days.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableHead>Product</TableHead>
              <TableHead>ABC</TableHead>
              <TableHead numeric>Units</TableHead>
              <TableHead numeric>Revenue ({currency})</TableHead>
              <TableHead numeric>Run rate</TableHead>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell>
                    <span className="font-medium text-ink">{row.title}</span>
                    <span className="block font-mono text-xs text-ink-faint">{row.sku}</span>
                  </TableCell>
                  <TableCell className="text-ink-muted">{row.abc ?? "—"}</TableCell>
                  <TableCell numeric>{formatNumber(row.unitsSold)}</TableCell>
                  <TableCell numeric>{formatNumber(row.revenueKes)}</TableCell>
                  <TableCell numeric>{row.runRate.toFixed(1)}/day</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  );
}
