"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { filterByFacets, type FacetOptions, type FacetSelection } from "@/lib/facets";
import {
  computeMoneyBand,
  formatMovePct,
  OVERSTOCK_COVER_DAYS,
  VERDICT_LABELS,
  VERDICT_TONES,
  type MoneyRow,
} from "@/lib/cost";
import type { CatalogueRow, CategoryUsage } from "@/lib/data/stock";
import { FacetFilterBar } from "./facet-filter-bar";
import { CatalogueExportBar } from "./catalogue-export";
import { HealthStrip, type HealthChip } from "./health-strip";
import { MoneyBand, type MoneyBandFilter } from "./money-band";
import { ManageCategories } from "./manage-categories";
import { RowEditor } from "./row-editor";

/**
 * Interactive catalogue: the money band + health strip read across the whole
 * active catalogue, the metadata facets filter it, the metric columns sort it —
 * all client-side over rows the server already computed through the shared metric
 * engine and the cost chain. Editing (cost pin, category, not-for-sale) lives in
 * an expanding row editor. Money values ride CostValue, so a money-blind member
 * never sees KES.
 */

function status(row: CatalogueRow): { label: string; tone: "negative" | "warning" | "positive" | "neutral" } {
  if (row.onHandUnits <= 0) return { label: "Stocked out", tone: "negative" };
  if (row.daysCover === null) return { label: "No sales", tone: "neutral" };
  if (row.daysCover < 7) return { label: "Reorder now", tone: "negative" };
  if (row.daysCover < 14) return { label: "Low", tone: "warning" };
  if (row.daysCover > 45) return { label: "Overstocked", tone: "neutral" };
  return { label: "Healthy", tone: "positive" };
}

type SortKey = "title" | "onHandUnits" | "runRate" | "daysCover" | "revenue30dKes" | "abc" | "moneyAtRestKes" | "marginPct";

const ABC_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

function compare(a: CatalogueRow, b: CatalogueRow, key: SortKey): number {
  switch (key) {
    case "title":
      return a.title.localeCompare(b.title);
    case "abc":
      return (ABC_RANK[a.abc ?? ""] ?? 9) - (ABC_RANK[b.abc ?? ""] ?? 9);
    case "daysCover":
      return (a.daysCover ?? Infinity) - (b.daysCover ?? Infinity);
    case "marginPct":
      return (a.marginPct ?? Infinity) - (b.marginPct ?? Infinity);
    default:
      return (a[key] ?? 0) - (b[key] ?? 0);
  }
}

/** The health-chip keys a row carries. Not-for-sale rows go quiet — their cost
 *  and supplier flags are suppressed, leaving only the not-for-sale chip. */
function rowHealthKeys(row: CatalogueRow): Set<string> {
  if (row.notForSale) return new Set(["not_for_sale"]);
  const keys = new Set<string>(row.facet.health);
  if (row.suspectCost) keys.add("suspect_cost");
  if (row.costMovedPct != null) keys.add("cost_moved");
  return keys;
}

const HEALTH_CHIP_META: { key: string; label: string; tone: HealthChip["tone"] }[] = [
  { key: "new", label: "New from Shopify", tone: "accent" },
  { key: "missing_cost", label: "Missing cost", tone: "warning" },
  { key: "suspect_cost", label: "Suspect cost", tone: "warning" },
  { key: "cost_moved", label: "Cost moved", tone: "warning" },
  { key: "no_supplier", label: "No supplier", tone: "warning" },
  { key: "no_sku", label: "No SKU", tone: "warning" },
  { key: "dup_sku", label: "Duplicate SKU", tone: "warning" },
  { key: "negative", label: "Negative stock", tone: "negative" },
  { key: "dead", label: "Not selling", tone: "neutral" },
  { key: "not_for_sale", label: "Not for sale", tone: "neutral" },
];

function moneyPredicate(f: Exclude<MoneyBandFilter, null>): (r: CatalogueRow) => boolean {
  switch (f) {
    case "dead_overstock":
      return (r) => !r.notForSale && r.onHandUnits > 0 && (r.daysCover == null || r.daysCover > OVERSTOCK_COVER_DAYS);
    case "revenue_at_risk":
      return (r) => !r.notForSale && (r.onHandUnits <= 0 || (r.daysCover != null && r.daysCover < r.leadDays));
    case "below_cost":
      return (r) => r.marginPct != null && r.marginPct < 0;
  }
}

export function CatalogueView({
  rows,
  facetOptions,
  categories,
  canViewCosts,
  canManage,
}: {
  rows: CatalogueRow[];
  facetOptions: FacetOptions;
  categories: CategoryUsage[];
  canViewCosts: boolean;
  canManage: boolean;
}) {
  const [selection, setSelection] = useState<FacetSelection>({});
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [desc, setDesc] = useState(false);
  const [healthFilter, setHealthFilter] = useState<string | null>(null);
  const [moneyFilter, setMoneyFilter] = useState<MoneyBandFilter>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const hasWarehouseStock = rows.some((r) => r.warehouseUnits > 0);
  const categoryNames = categories.map((c) => c.name);

  const band = useMemo(() => {
    const moneyRows: MoneyRow[] = rows.map((r) => ({
      costKes: r.costKes ?? 0,
      priceKes: r.priceKes,
      sellableOnHand: r.onHandUnits,
      coverDays: r.daysCover,
      leadDays: r.leadDays,
      revenue30dKes: r.revenue30dKes,
      moneyAtRestKes: r.moneyAtRestKes ?? 0,
      notForSale: r.notForSale,
    }));
    return computeMoneyBand(moneyRows);
  }, [rows]);

  const chips = useMemo<HealthChip[]>(() => {
    const counts = new Map<string, number>();
    for (const r of rows) for (const k of rowHealthKeys(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
    return HEALTH_CHIP_META.map((m) => ({ ...m, count: counts.get(m.key) ?? 0 }));
  }, [rows]);

  const visible = useMemo(() => {
    let filtered = filterByFacets(
      rows.map((r) => ({ ...r.facet, row: r })),
      selection,
    ).map((f) => f.row);
    if (healthFilter) filtered = filtered.filter((r) => rowHealthKeys(r).has(healthFilter));
    if (moneyFilter) filtered = filtered.filter(moneyPredicate(moneyFilter));
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    return desc ? sorted.reverse() : sorted;
  }, [rows, selection, healthFilter, moneyFilter, sortKey, desc]);

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

  const colCount = 7 + (hasWarehouseStock ? 1 : 0);

  return (
    <div className="space-y-4">
      {canViewCosts && (
        <MoneyBand band={band} canViewCosts={canViewCosts} active={moneyFilter} onSelect={setMoneyFilter} />
      )}

      <Card>
        <CardHeader
          title="Catalogue"
          subtitle="Fix any issue without leaving the page"
          action={
            <div className="flex flex-wrap items-center gap-2">
              {canManage && <ManageCategories categories={categories} />}
              <Link
                href="/costs"
                className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-ink-muted hover:text-ink"
              >
                Costs &amp; coverage
              </Link>
              <CatalogueExportBar rows={exportRows} canViewCosts={canViewCosts} />
            </div>
          }
        />

        <HealthStrip
          total={rows.length}
          shown={visible.length}
          chips={chips}
          active={healthFilter}
          onToggle={(key) => setHealthFilter((cur) => (cur === key ? null : key))}
          onClear={() => setHealthFilter(null)}
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
            {canViewCosts && <option value="marginPct">Margin %</option>}
            {canViewCosts && <option value="moneyAtRestKes">Cash tied up</option>}
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
              <TableHead>ABC</TableHead>
              <TableHead numeric>Cost</TableHead>
              <TableHead numeric>Margin</TableHead>
              <TableHead numeric>On hand</TableHead>
              {hasWarehouseStock && <TableHead numeric>In warehouse</TableHead>}
              <TableHead numeric>Cash tied up</TableHead>
              <TableHead numeric>Rev · 30d (KES)</TableHead>
              <TableHead>Verdict</TableHead>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const open = expandedId === row.productId;
                return (
                  <RowGroup
                    key={row.productId}
                    row={row}
                    open={open}
                    onToggle={() => setExpandedId(open ? null : row.productId)}
                    hasWarehouseStock={hasWarehouseStock}
                    canViewCosts={canViewCosts}
                    canManage={canManage}
                    categoryNames={categoryNames}
                    colCount={colCount}
                  />
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

const SOURCE_SHORT: Record<string, string> = { manual: "typed", qb: "QuickBooks", shopify: "Shopify", missing: "missing" };

function RowGroup({
  row,
  open,
  onToggle,
  hasWarehouseStock,
  canViewCosts,
  canManage,
  categoryNames,
  colCount,
}: {
  row: CatalogueRow;
  open: boolean;
  onToggle: () => void;
  hasWarehouseStock: boolean;
  canViewCosts: boolean;
  canManage: boolean;
  categoryNames: string[];
  colCount: number;
}) {
  // Margin reveals cost, so it masks for a money-blind member — as a non-KES
  // dot mask (it isn't a KES figure), keeping the cost mask distinct.
  const marginCell = !canViewCosts ? "•••" : row.marginPct == null ? "—" : `${row.marginPct.toFixed(0)}%`;
  return (
    <>
      <TableRow className={open ? "bg-surface-2/60" : undefined}>
        <TableCell className="max-w-[22rem]">
          <button type="button" onClick={onToggle} className="flex items-center gap-2 text-left">
            <span className="text-ink-faint">{open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}</span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium text-ink">{row.title}</span>
                <RowDots row={row} />
              </span>
              <span className="block truncate font-mono text-xs text-ink-faint">
                {row.sku || "no SKU"}
                {row.customCategory ? ` · ${row.customCategory}` : ""}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell className="text-ink-muted">{row.abc ?? "—"}</TableCell>
        <TableCell numeric>
          <span className="inline-flex flex-col items-end">
            <CostValue amount={row.costKes} canViewCosts={canViewCosts} />
            <span className="text-xs text-ink-faint">{SOURCE_SHORT[row.costSource]}</span>
          </span>
        </TableCell>
        <TableCell numeric className={canViewCosts && row.marginPct != null && row.marginPct < 0 ? "font-semibold text-negative" : undefined}>
          {marginCell}
        </TableCell>
        <TableCell numeric>{row.onHandUnits}</TableCell>
        {hasWarehouseStock && (
          <TableCell numeric className="text-ink-muted">
            {row.warehouseUnits > 0 ? row.warehouseUnits : "—"}
          </TableCell>
        )}
        <TableCell numeric>
          <CostValue amount={row.moneyAtRestKes} canViewCosts={canViewCosts} compact />
        </TableCell>
        <TableCell numeric className="text-ink-muted">
          {/* Revenue is a sales figure (visible to every role); rendered as a
              plain KES amount whose unit lives in the header, so it never
              collides with the cost mask a money-blind member sees. */}
          {row.revenue30dKes > 0 ? Math.round(row.revenue30dKes).toLocaleString("en-KE") : "—"}
        </TableCell>
        <TableCell>
          {row.verdict ? (
            <Badge tone={VERDICT_TONES[row.verdict]}>{VERDICT_LABELS[row.verdict]}</Badge>
          ) : (
            <Badge tone="neutral">Not for sale</Badge>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <tr>
          <td colSpan={colCount} className="p-0">
            <RowEditor row={row} categories={categoryNames} canViewCosts={canViewCosts} canManage={canManage} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Colored issue dots on the row (spec: issues show as dots; editing lives in the
 *  editor). Each dot names its issue on hover. */
function RowDots({ row }: { row: CatalogueRow }) {
  const dots: { title: string; className: string }[] = [];
  if (row.missingCost) dots.push({ title: "Missing cost", className: "bg-warning" });
  if (row.suspectCost) dots.push({ title: "Suspect cost (≥ price)", className: "bg-warning" });
  if (row.costMovedPct != null) dots.push({ title: `Cost moved ${formatMovePct(row.costMovedPct)}`, className: "bg-warning" });
  if (row.heldOffBuyList && !row.missingCost) dots.push({ title: "Held off the buy list", className: "bg-negative" });
  if (dots.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {dots.map((d, i) => (
        <span key={i} title={d.title} className={`inline-block size-1.5 rounded-full ${d.className}`} />
      ))}
    </span>
  );
}
