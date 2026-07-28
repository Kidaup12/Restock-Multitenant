"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deriveFacetOptions, filterByFacets, type FacetSelection } from "@/lib/facets";
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
import type { OwnerFlags } from "./owner-flags";

/**
 * Interactive catalogue: the money band + health strip read across the catalogue
 * in scope, the metadata facets filter it, the metric columns sort it — all
 * client-side over rows the server already computed through the shared metric
 * engine and the cost chain. Editing (cost pin, category, not-for-sale) lives in
 * an expanding row editor. Money values ride CostValue, so a money-blind member
 * never sees a cost figure.
 *
 * The server sends every product, selling or not. The scope chips decide which
 * of them the screen is about: "Selling" by default, so the day-to-day view is
 * not padded with SKUs the shop retired, and the other chips carry their counts
 * so nothing is silently absent.
 */

export const SCOPES = ["selling", "not_selling", "all"] as const;
type Scope = (typeof SCOPES)[number];

export const SCOPE_LABELS: Record<Scope, string> = {
  selling: "Selling",
  not_selling: "Archived & removed",
  all: "All products",
};

/** Exported for tests: which scope a row belongs to. */
export function inScope(row: CatalogueRow, scope: Scope): boolean {
  if (scope === "all") return true;
  return scope === "selling" ? row.buyable : !row.buyable;
}

function status(row: CatalogueRow): { label: string; tone: "negative" | "warning" | "positive" | "neutral" } {
  if (!row.buyable) return { label: row.lifecycleLabel, tone: "neutral" };
  if (row.onHandUnits <= 0) return { label: "Stocked out", tone: "negative" };
  if (row.daysCover === null) return { label: "No sales", tone: "neutral" };
  if (row.daysCover < 7) return { label: "Reorder now", tone: "negative" };
  if (row.daysCover < 14) return { label: "Low", tone: "warning" };
  if (row.daysCover > 45) return { label: "Overstocked", tone: "neutral" };
  return { label: "Healthy", tone: "positive" };
}

/** ETA on inbound stock — same day/month form the rest of the app uses. */
function formatEta(date: Date): string {
  return new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
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

/** The health-chip keys a row carries. A row the shop no longer sells goes quiet
 *  on the data-quality flags — a missing cost on an archived SKU is not a job —
 *  leaving its lifecycle. A sync failure counts either way: a row that stopped
 *  updating is a problem whatever its status. */
function rowHealthKeys(row: CatalogueRow): Set<string> {
  const keys = new Set<string>();
  if (row.syncError) keys.add("sync_error");
  if (row.lifecycle !== "active") keys.add(`lifecycle_${row.lifecycle}`);
  if (!row.buyable) return keys;
  for (const flag of row.facet.health) keys.add(flag);
  if (row.suspectCost) keys.add("suspect_cost");
  if (row.costMovedPct != null) keys.add("cost_moved");
  return keys;
}

const HEALTH_CHIP_META: { key: string; label: string; tone: HealthChip["tone"] }[] = [
  { key: "new", label: "New from Shopify", tone: "accent" },
  { key: "sync_error", label: "Sync problem", tone: "negative" },
  { key: "missing_cost", label: "Missing cost", tone: "warning" },
  { key: "suspect_cost", label: "Suspect cost", tone: "warning" },
  { key: "cost_moved", label: "Cost moved", tone: "warning" },
  { key: "no_supplier", label: "No supplier", tone: "warning" },
  { key: "no_sku", label: "No SKU", tone: "warning" },
  { key: "dup_sku", label: "Duplicate SKU", tone: "warning" },
  { key: "negative", label: "Negative stock", tone: "negative" },
  { key: "dead", label: "Not selling", tone: "neutral" },
];

/** Lifecycle chips are built from the rows rather than a fixed list, because the
 *  label travels on the row — the shared vocabulary lives in the db package, and
 *  importing that here would pull the Prisma client into the browser. */
function lifecycleChips(rows: CatalogueRow[]): HealthChip[] {
  const byKey = new Map<string, HealthChip>();
  for (const row of rows) {
    if (row.lifecycle === "active") continue;
    const key = `lifecycle_${row.lifecycle}`;
    const chip = byKey.get(key);
    if (chip) chip.count += 1;
    else byKey.set(key, { key, label: row.lifecycleLabel, count: 1, tone: row.lifecycle === "removed" ? "negative" : "neutral" });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function moneyPredicate(f: Exclude<MoneyBandFilter, null>): (r: CatalogueRow) => boolean {
  switch (f) {
    case "dead_overstock":
      return (r) => r.buyable && r.onHandUnits > 0 && (r.daysCover == null || r.daysCover > OVERSTOCK_COVER_DAYS);
    case "revenue_at_risk":
      return (r) => r.buyable && (r.onHandUnits <= 0 || (r.daysCover != null && r.daysCover < r.leadDays));
    case "below_cost":
      return (r) => r.marginPct != null && r.marginPct < 0;
  }
}

export function CatalogueView({
  rows,
  categories,
  ownerFlags,
  canViewCosts,
  canManage,
}: {
  rows: CatalogueRow[];
  categories: CategoryUsage[];
  ownerFlags: Record<string, OwnerFlags>;
  canViewCosts: boolean;
  canManage: boolean;
}) {
  const currency = useCurrency();
  const [selection, setSelection] = useState<FacetSelection>({});
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [desc, setDesc] = useState(false);
  const [scope, setScope] = useState<Scope>("selling");
  const [healthFilter, setHealthFilter] = useState<string | null>(null);
  const [moneyFilter, setMoneyFilter] = useState<MoneyBandFilter>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const categoryNames = categories.map((c) => c.name);

  // Everything below the scope chips — counts, money band, table — reads the
  // scoped catalogue, so switching scope re-frames the whole screen rather than
  // just hiding rows. The chip counts themselves read the full catalogue.
  const scoped = useMemo(() => rows.filter((r) => inScope(r, scope)), [rows, scope]);
  const scopeChips = useMemo<HealthChip[]>(
    () =>
      SCOPES.map((key) => ({
        key,
        label: SCOPE_LABELS[key],
        count: rows.filter((r) => inScope(r, key)).length,
        tone: "neutral" as const,
      })),
    [rows],
  );

  const hasWarehouseStock = scoped.some((r) => r.warehouseUnits > 0);

  const band = useMemo(() => {
    const moneyRows: MoneyRow[] = scoped.map((r) => ({
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
  }, [scoped]);

  // Derived from the SAME scoped rows the health chips count. Deriving these
  // server-side over the whole catalogue put two controls with identical
  // labels and different numbers on one screen.
  const facetOptions = useMemo(() => deriveFacetOptions(scoped.map((r) => r.facet)), [scoped]);

  const chips = useMemo<HealthChip[]>(() => {
    const counts = new Map<string, number>();
    for (const r of scoped) for (const k of rowHealthKeys(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [
      ...HEALTH_CHIP_META.map((m) => ({ ...m, count: counts.get(m.key) ?? 0 })),
      ...lifecycleChips(scoped),
    ];
  }, [scoped]);

  const visible = useMemo(() => {
    let filtered = filterByFacets(
      scoped.map((r) => ({ ...r.facet, row: r })),
      selection,
    ).map((f) => f.row);
    if (healthFilter) filtered = filtered.filter((r) => rowHealthKeys(r).has(healthFilter));
    if (moneyFilter) filtered = filtered.filter(moneyPredicate(moneyFilter));
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    return desc ? sorted.reverse() : sorted;
  }, [scoped, selection, healthFilter, moneyFilter, sortKey, desc]);

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

  // Product · ABC · Cost · Margin · On hand · On order · Sells/day · Cover ·
  // Cash tied up · Revenue · Verdict, plus the optional warehouse column.
  const colCount = 11 + (hasWarehouseStock ? 1 : 0);

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
          total={scoped.length}
          shown={visible.length}
          chips={chips}
          active={healthFilter}
          onToggle={(key) => setHealthFilter((cur) => (cur === key ? null : key))}
          onClear={() => setHealthFilter(null)}
          scopes={scopeChips}
          scope={scope}
          onScope={(key) => {
            setScope(key as Scope);
            setHealthFilter(null); // the old chip may not exist in the new scope
          }}
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
              <TableHead numeric>On order</TableHead>
              <TableHead numeric>Sells/day</TableHead>
              <TableHead numeric>Cover</TableHead>
              <TableHead numeric>Cash tied up</TableHead>
              <TableHead numeric>Rev · 30d ({currency})</TableHead>
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
                    flags={ownerFlags[row.productId] ?? { active: true, activeOverride: false }}
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
  flags,
  colCount,
}: {
  row: CatalogueRow;
  open: boolean;
  onToggle: () => void;
  hasWarehouseStock: boolean;
  canViewCosts: boolean;
  canManage: boolean;
  categoryNames: string[];
  flags: OwnerFlags;
  colCount: number;
}) {
  // Margin reveals cost, so it masks for a money-blind member — as a bare dot
  // mask (margin is a percentage, not money), keeping the cost mask distinct.
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
                {/* Sibling variants share a title — the variant label is what
                    stops six shades reading as six duplicates. */}
                {row.variantTitle ? <span className="font-sans text-ink-muted"> · {row.variantTitle}</span> : null}
                {row.customCategory ? ` · ${row.customCategory}` : ""}
              </span>
              {/* Why this row is off the buy list, in the owner's words —
                  otherwise a retired SKU reads as ordinary stock. */}
              {row.lifecycleReason && (
                <span className="block truncate text-xs text-ink-muted">{row.lifecycleReason}</span>
              )}
              {row.syncError && (
                <span className="block truncate text-xs text-negative">Sync problem: {row.syncError}</span>
              )}
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
        <TableCell numeric className="text-ink-muted">
          {row.onOrderUnits > 0 ? (
            <span className="inline-flex flex-col items-end">
              <span className="text-ink">{row.onOrderUnits}</span>
              {/* An empty shelf with stock en route is not a re-order — the ETA
                  is what tells the two apart at a glance. */}
              <span className="text-xs text-ink-faint">
                {row.expectedArrivalAt ? formatEta(row.expectedArrivalAt) : "no ETA"}
              </span>
            </span>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell numeric className="text-ink-muted">
          {/* Two decimals: a slow mover at 0.03/day must not read as zero. */}
          {row.runRate > 0 ? row.runRate.toFixed(2) : "—"}
        </TableCell>
        <TableCell numeric className="text-ink-muted">
          {row.daysCover != null ? `${row.daysCover}d` : "—"}
        </TableCell>
        <TableCell numeric>
          <CostValue amount={row.moneyAtRestKes} canViewCosts={canViewCosts} compact />
        </TableCell>
        <TableCell numeric className="text-ink-muted">
          {/* Revenue is a sales figure (visible to every role); rendered as a
              plain amount whose unit lives in the header, so it never collides
              with the cost mask a money-blind member sees. */}
          {row.revenue30dKes > 0 ? formatNumber(row.revenue30dKes) : "—"}
        </TableCell>
        <TableCell>
          <span className="flex flex-wrap items-center gap-1">
            {row.verdict && <Badge tone={VERDICT_TONES[row.verdict]}>{VERDICT_LABELS[row.verdict]}</Badge>}
            {/* Lifecycle rides the same badge vocabulary. A row the shop stopped
                selling has no cover verdict, so this is the only badge it
                carries; an unlisted row keeps its verdict and gains this. */}
            {row.lifecycle !== "active" && (
              <Badge tone={row.lifecycle === "removed" ? "negative" : "neutral"}>{row.lifecycleLabel}</Badge>
            )}
          </span>
        </TableCell>
      </TableRow>
      {open && (
        <tr>
          <td colSpan={colCount} className="p-0">
            <RowEditor
              row={row}
              categories={categoryNames}
              flags={flags}
              canViewCosts={canViewCosts}
              canManage={canManage}
            />
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
  if (row.syncError) dots.push({ title: `Sync problem: ${row.syncError}`, className: "bg-negative" });
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
