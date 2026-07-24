"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { filterByFacets, type FacetOptions, type FacetSelection } from "@/lib/facets";
import type { CatalogueRow } from "@/lib/data/stock";
import { FacetFilterBar } from "./facet-filter-bar";
import { CatalogueExportBar } from "./catalogue-export";

/**
 * Interactive catalogue: the metadata facets filter it and the metric columns
 * sort it, all client-side over rows the server already computed through the
 * shared metric engine. "Export what you see" is honoured by construction — the
 * export bar receives the same filtered+sorted rows the table renders.
 */

function status(row: CatalogueRow): {
  label: string;
  tone: "negative" | "warning" | "positive" | "neutral";
} {
  if (row.onHandUnits <= 0) return { label: "Stocked out", tone: "negative" };
  if (row.daysCover === null) return { label: "No sales", tone: "neutral" };
  if (row.daysCover < 7) return { label: "Reorder now", tone: "negative" };
  if (row.daysCover < 14) return { label: "Low", tone: "warning" };
  if (row.daysCover > 45) return { label: "Overstocked", tone: "neutral" };
  return { label: "Healthy", tone: "positive" };
}

type SortKey = "title" | "onHandUnits" | "runRate" | "daysCover" | "revenue30dKes" | "abc" | "moneyAtRestKes";

const ABC_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

function compare(a: CatalogueRow, b: CatalogueRow, key: SortKey): number {
  switch (key) {
    case "title":
      return a.title.localeCompare(b.title);
    case "abc":
      return (ABC_RANK[a.abc ?? ""] ?? 9) - (ABC_RANK[b.abc ?? ""] ?? 9);
    case "daysCover":
      // Nulls (no run rate) sort last regardless of direction flip below.
      return (a.daysCover ?? Infinity) - (b.daysCover ?? Infinity);
    default:
      return (a[key] ?? 0) - (b[key] ?? 0);
  }
}

export function CatalogueView({
  rows,
  facetOptions,
  canViewCosts,
}: {
  rows: CatalogueRow[];
  facetOptions: FacetOptions;
  canViewCosts: boolean;
}) {
  const [selection, setSelection] = useState<FacetSelection>({});
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [desc, setDesc] = useState(false);

  const hasWarehouseStock = rows.some((r) => r.warehouseUnits > 0);

  const visible = useMemo(() => {
    const filtered = filterByFacets(
      rows.map((r) => ({ ...r.facet, row: r })),
      selection
    ).map((f) => f.row);
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    return desc ? sorted.reverse() : sorted;
  }, [rows, selection, sortKey, desc]);

  const exportRows = visible.map((row) => ({
    title: row.title,
    sku: row.sku,
    onHandUnits: row.onHandUnits,
    warehouseUnits: row.warehouseUnits,
    daysCover: row.onHandUnits <= 0 ? null : row.daysCover,
    status: status(row).label,
    costKes: row.costKes,
    stockValueKes: row.stockValueKes,
  }));

  return (
    <Card>
      <CardHeader
        title="Catalogue"
        subtitle={
          visible.length === rows.length
            ? `${rows.length} products`
            : `${visible.length} of ${rows.length} products`
        }
        action={<CatalogueExportBar rows={exportRows} canViewCosts={canViewCosts} />}
      />

      <FacetFilterBar options={facetOptions} selection={selection} onChange={setSelection} />

      <div className="flex items-center gap-2 px-4 py-2 text-sm text-ink-muted">
        <span>Sort</span>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded-md border border-edge bg-surface px-2 py-1 text-ink"
        >
          <option value="title">Product</option>
          <option value="onHandUnits">On hand</option>
          <option value="runRate">Run rate</option>
          <option value="daysCover">Days cover</option>
          <option value="revenue30dKes">Revenue (30d)</option>
          <option value="abc">ABC class</option>
          {canViewCosts && <option value="moneyAtRestKes">Money at rest</option>}
        </select>
        <button
          type="button"
          onClick={() => setDesc((d) => !d)}
          className="rounded-md border border-edge bg-surface px-2 py-1 text-ink hover:bg-surface-2"
        >
          {desc ? "Desc ↓" : "Asc ↑"}
        </button>
      </div>

      <CardContent className="p-0 py-2">
        <Table>
          <TableHeader>
            <TableHead>Product</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>ABC</TableHead>
            <TableHead numeric>On hand</TableHead>
            {hasWarehouseStock && <TableHead numeric>In warehouse</TableHead>}
            <TableHead numeric>Run rate</TableHead>
            <TableHead numeric>Days cover</TableHead>
            <TableHead>Status</TableHead>
            <TableHead numeric>Stock value</TableHead>
          </TableHeader>
          <TableBody>
            {visible.map((row) => {
              const s = status(row);
              return (
                <TableRow key={row.productId}>
                  <TableCell className="font-medium text-ink">{row.title}</TableCell>
                  <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                  <TableCell className="text-ink-muted">{row.abc ?? "—"}</TableCell>
                  <TableCell numeric>{row.onHandUnits}</TableCell>
                  {hasWarehouseStock && (
                    <TableCell numeric className="text-ink-muted">
                      {row.warehouseUnits > 0 ? row.warehouseUnits : "—"}
                    </TableCell>
                  )}
                  <TableCell numeric className="text-ink-muted">
                    {row.runRate > 0 ? `${row.runRate.toFixed(1)}/day` : "—"}
                  </TableCell>
                  <TableCell numeric>
                    {row.onHandUnits <= 0 || row.daysCover === null ? "—" : `${row.daysCover}d`}
                  </TableCell>
                  <TableCell>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </TableCell>
                  <TableCell numeric>
                    <CostValue amount={row.stockValueKes} canViewCosts={canViewCosts} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
