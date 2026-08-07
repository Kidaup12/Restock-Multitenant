import type { CatalogueRow } from "@/lib/data/stock";
import { computeMoneyBand, OVERSTOCK_COVER_DAYS, type MoneyBand, type MoneyRow } from "@/lib/cost";
import { deriveFacetOptions, filterByFacets, type FacetOptions, type FacetSelection } from "@/lib/facets";

/**
 * How the catalogue screen turns rows into what it shows: scope, chips, money
 * band, facet options, filter, sort, page.
 *
 * It lives outside the screen because BOTH sides need it. The server counts and
 * filters the whole catalogue here, then sends one page of rows; the client
 * renders them. Sharing the predicates is what keeps a chip's count and the rows
 * it filters to the same answer — two implementations would drift the first time
 * one of them changed.
 *
 * Pure and server-safe on purpose: nothing here may import a "use client"
 * module. A client module's exports throw when a server component calls them,
 * and neither typecheck nor the suite catches it — only the build does.
 */

/**
 * Rows sent to the browser at once. Counting, filtering and exporting still read
 * the whole catalogue — only the page travels, because a shop with 400–1000
 * products pays for every row it serialises whether or not anyone scrolls to it.
 * 50 is about two screens of scrolling: enough to scan a category in one go,
 * small enough that the page cost stops growing with the catalogue.
 */
export const PAGE_SIZE = 50;

export const SCOPES = ["selling", "not_selling", "all"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_LABELS: Record<Scope, string> = {
  selling: "Selling",
  not_selling: "Archived & removed",
  all: "All products",
};

/** Which scope a row belongs to. */
export function inScope(row: CatalogueRow, scope: Scope): boolean {
  if (scope === "all") return true;
  return scope === "selling" ? row.buyable : !row.buyable;
}

export const SORT_KEYS = [
  "title",
  "onHandUnits",
  "runRate",
  "daysCover",
  "revenue30dKes",
  "abc",
  "moneyAtRestKes",
  "marginPct",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

const ABC_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

export function compare(a: CatalogueRow, b: CatalogueRow, key: SortKey): number {
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

export type ChipTone = "neutral" | "warning" | "negative" | "accent";

export type Chip = {
  key: string;
  label: string;
  count: number;
  tone: ChipTone;
};

export type StatusTone = "negative" | "warning" | "positive" | "neutral";

/** The row's one-word standing, shared by the table and the export so a CSV
 *  never disagrees with the screen it was taken from. */
export function status(row: CatalogueRow): { label: string; tone: StatusTone } {
  if (!row.buyable) return { label: row.lifecycleLabel, tone: "neutral" };
  if (row.onHandUnits <= 0) return { label: "Stocked out", tone: "negative" };
  if (row.daysCover === null) return { label: "No sales", tone: "neutral" };
  if (row.daysCover < 7) return { label: "Reorder now", tone: "negative" };
  if (row.daysCover < 14) return { label: "Low", tone: "warning" };
  if (row.daysCover > 45) return { label: "Overstocked", tone: "neutral" };
  return { label: "Healthy", tone: "positive" };
}

/** The health-chip keys a row carries. A row the shop no longer sells goes quiet
 *  on the data-quality flags — a missing cost on an archived SKU is not a job —
 *  leaving its lifecycle. A sync failure counts either way: a row that stopped
 *  updating is a problem whatever its status. */
export function rowHealthKeys(row: CatalogueRow): Set<string> {
  const keys = new Set<string>();
  if (row.syncError) keys.add("sync_error");
  if (row.lifecycle !== "active") keys.add(`lifecycle_${row.lifecycle}`);
  if (!row.buyable) return keys;
  for (const flag of row.facet.health) keys.add(flag);
  if (row.suspectCost) keys.add("suspect_cost");
  if (row.costMovedPct != null) keys.add("cost_moved");
  return keys;
}

const HEALTH_CHIP_META: { key: string; label: string; tone: ChipTone }[] = [
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
 *  importing that into the browser would pull the Prisma client with it. */
function lifecycleChips(rows: CatalogueRow[]): Chip[] {
  const byKey = new Map<string, Chip>();
  for (const row of rows) {
    if (row.lifecycle === "active") continue;
    const key = `lifecycle_${row.lifecycle}`;
    const chip = byKey.get(key);
    if (chip) chip.count += 1;
    else
      byKey.set(key, {
        key,
        label: row.lifecycleLabel,
        count: 1,
        tone: row.lifecycle === "removed" ? "negative" : "neutral",
      });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export type MoneyBandFilter = "dead_overstock" | "revenue_at_risk" | "below_cost" | null;

export function moneyPredicate(f: Exclude<MoneyBandFilter, null>): (r: CatalogueRow) => boolean {
  switch (f) {
    case "dead_overstock":
      return (r) => r.buyable && r.onHandUnits > 0 && (r.daysCover == null || r.daysCover > OVERSTOCK_COVER_DAYS);
    case "revenue_at_risk":
      return (r) => r.buyable && (r.onHandUnits <= 0 || (r.daysCover != null && r.daysCover < r.leadDays));
    case "below_cost":
      return (r) => r.marginPct != null && r.marginPct < 0;
  }
}

/** Everything the screen filters and sorts by. Each one changes WHICH rows
 *  match, so each one also sends the reader back to page 1. */
export type CatalogueQuery = {
  scope: Scope;
  selection: FacetSelection;
  healthFilter: string | null;
  moneyFilter: MoneyBandFilter;
  /** Free text, already trimmed. Empty means no text filter. */
  search: string;
  sortKey: SortKey;
  desc: boolean;
  page: number;
};

export const DEFAULT_QUERY: CatalogueQuery = {
  scope: "selling",
  selection: {},
  healthFilter: null,
  moneyFilter: null,
  search: "",
  sortKey: "title",
  desc: false,
  page: 0,
};

/** The text a search term is matched against: everything printed in the
 *  product cell, so anything the reader can see on the row is findable. */
function haystack(row: CatalogueRow): string {
  return [row.title, row.sku, row.variantTitle, row.vendor, row.customCategory]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Whitespace-separated terms, ANDed. "nivea 250" finds the 250ml Nivea
 *  whichever order the words appear in the title, which is what someone typing
 *  half-remembered packaging actually wants. Substring rather than word-prefix:
 *  SKUs here run together (`NIV-250ML`), so a prefix match would miss `250`. */
export function matchesSearch(row: CatalogueRow, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(row);
  return terms.every((t) => text.includes(t));
}

/** The catalogue-wide readings: what the chips, band and facet bar report. All
 *  of them count the SCOPED catalogue, never the page — paging changes what is
 *  on screen and nothing else. */
export type CatalogueAggregates = {
  /** Scope chips carry counts over the whole catalogue, so a shop with archived
   *  SKUs can see they exist without leaving the day-to-day view. */
  scopeChips: Chip[];
  healthChips: Chip[];
  facetOptions: FacetOptions;
  /** Null for a money-blind member. The band is four cost sums; it never renders
   *  for them, but "the component doesn't show it" is not the same as "the
   *  payload doesn't carry it" — redaction belongs at the data layer. */
  band: MoneyBand | null;
  /** Rows in scope, before the facet/health/money filters. */
  scopedCount: number;
  /** Rows matching every active filter — what the pager counts against. */
  matchedCount: number;
  /** Σ stock-value-at-cost across the MATCHED rows: the export's footnote, which
   *  describes the file being exported rather than the page on screen. Null for
   *  a money-blind member, like every other cost figure. */
  matchedStockValueKes: number | null;
  /** Any row in scope holding warehouse stock, which is what decides whether the
   *  table shows the warehouse column at all. */
  hasWarehouseStock: boolean;
};

/** Scope, then the three filters, then sort. Exported so the export action can
 *  reproduce exactly the list the reader is looking at. */
export function selectRows(rows: CatalogueRow[], q: CatalogueQuery): CatalogueRow[] {
  const scoped = rows.filter((r) => inScope(r, q.scope));
  let filtered = filterByFacets(
    scoped.map((r) => ({ ...r.facet, row: r })),
    q.selection,
  ).map((f) => f.row);
  if (q.healthFilter) filtered = filtered.filter((r) => rowHealthKeys(r).has(q.healthFilter!));
  if (q.moneyFilter) filtered = filtered.filter(moneyPredicate(q.moneyFilter));
  if (q.search) filtered = filtered.filter((r) => matchesSearch(r, q.search));
  const sorted = [...filtered].sort((a, b) => compare(a, b, q.sortKey));
  return q.desc ? sorted.reverse() : sorted;
}

export function buildAggregates(
  rows: CatalogueRow[],
  q: CatalogueQuery,
  matched: CatalogueRow[],
  { canViewCosts }: { canViewCosts: boolean },
): CatalogueAggregates {
  const scoped = rows.filter((r) => inScope(r, q.scope));

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

  const healthCounts = new Map<string, number>();
  for (const r of scoped) for (const k of rowHealthKeys(r)) healthCounts.set(k, (healthCounts.get(k) ?? 0) + 1);

  return {
    scopeChips: SCOPES.map((key) => ({
      key,
      label: SCOPE_LABELS[key],
      count: rows.filter((r) => inScope(r, key)).length,
      tone: "neutral" as const,
    })),
    healthChips: [
      ...HEALTH_CHIP_META.map((m) => ({ ...m, count: healthCounts.get(m.key) ?? 0 })),
      ...lifecycleChips(scoped),
    ],
    // Derived from the SAME scoped rows the health chips count. Deriving these
    // over the whole catalogue put two controls with identical labels and
    // different numbers on one screen.
    facetOptions: deriveFacetOptions(scoped.map((r) => r.facet)),
    band: canViewCosts ? computeMoneyBand(moneyRows) : null,
    scopedCount: scoped.length,
    matchedCount: matched.length,
    matchedStockValueKes: canViewCosts
      ? matched.reduce((sum, r) => sum + (r.stockValueKes ?? 0), 0)
      : null,
    hasWarehouseStock: scoped.some((r) => r.warehouseUnits > 0),
  };
}

/** Clamp to a real page. What survives a server refresh (an edit re-renders with
 *  fewer rows) landing the reader past the end. */
export function pageBounds(matchedCount: number, page: number): { pageCount: number; current: number; start: number } {
  const pageCount = Math.max(1, Math.ceil(matchedCount / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return { pageCount, current, start: current * PAGE_SIZE };
}
