"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { formatEta } from "@/lib/dates";
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
import type { FacetSelection } from "@/lib/facets";
import { formatMovePct, VERDICT_LABELS, VERDICT_TONES } from "@/lib/cost";
import {
  catalogueQueryToSearch,
  withQuery,
  type CatalogueQuery,
  type Scope,
  type SortKey,
} from "@/lib/catalogue";
import type { CatalogueRow, CatalogueScreen, CategoryUsage } from "@/lib/data/stock";
import { BulkLeadTimeBar } from "./bulk-lead-time-bar";
import { CatalogueSearch } from "./catalogue-search";
import { FacetFilterBar } from "./facet-filter-bar";
import { CatalogueExportBar } from "./catalogue-export";
import { HealthStrip } from "./health-strip";
import { MoneyBand } from "./money-band";
import { ManageCategories } from "./manage-categories";
import { RowEditor } from "./row-editor";
import { exportCatalogueAction } from "./actions";
import type { OwnerFlags } from "./owner-flags";

/**
 * Interactive catalogue: the money band + health strip read across the catalogue
 * in scope, the metadata facets filter it, the metric columns sort it. Editing
 * (cost pin, category, not-for-sale) lives in an expanding row editor. Money
 * values ride CostValue, so a money-blind member never sees a cost figure.
 *
 * The scope chips decide which catalogue the screen is about: "Selling" by
 * default, so the day-to-day view is not padded with SKUs the shop retired, and
 * the other chips carry their counts so nothing is silently absent.
 *
 * The counting, filtering and sorting all happen on the server now (lib/data/stock
 * → lib/catalogue), which sends the readings plus ONE page of rows. A shop with
 * 400–1000 products otherwise pays to serialise every row it owns on every load,
 * whether or not anyone scrolls to it. So every control here writes to the URL
 * and the server answers: state that used to live in this component is now the
 * address bar, which also makes a filtered catalogue linkable and survives the
 * revalidate after an edit.
 */

/** How many columns the table has, for the colSpan an expanded row must reach.
 *  The data columns are fixed — Product · ABC · Cost · Margin · On hand · In
 *  warehouse · En route · Sells/day · Cover · Cash tied up · Revenue · Verdict —
 *  and only the tick column an editor sees varies. Derived in one place so the
 *  count cannot drift from the header. */
export function catalogueColCount(canManage: boolean): number {
  return 12 + (canManage ? 1 : 0);
}

export function CatalogueView({
  screen,
  query,
  categories,
  ownerFlags,
  canViewCosts,
  canManage,
}: {
  screen: CatalogueScreen;
  query: CatalogueQuery;
  categories: CategoryUsage[];
  ownerFlags: Record<string, OwnerFlags>;
  canViewCosts: boolean;
  canManage: boolean;
}) {
  const currency = useCurrency();
  const router = useRouter();
  // Which row is open is the one piece of state that does NOT change which rows
  // match, so it stays local — putting it in the URL would make expanding a row
  // a history entry.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Selection is local for the same reason, and page-scoped: ticks travel with
  // what is on screen. `allMatching` is the exception — it says "everything
  // these filters match", which only the server can enumerate, so it is a flag
  // rather than a list of ids the browser never had.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);

  const { rows, aggregates, pageCount, page, from } = screen;
  const categoryNames = categories.map((c) => c.name);

  const pageIds = useMemo(() => rows.map((r) => r.productId), [rows]);
  const pageAllPicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const selectedCount = allMatching ? aggregates.matchedCount : picked.size;

  function clearSelection() {
    setPicked(new Set());
    setAllMatching(false);
  }

  function togglePicked(productId: string) {
    // Ticking a row after "all matching" means the reader is narrowing by hand,
    // so the blanket selection stops applying.
    setAllMatching(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  function togglePage() {
    setAllMatching(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (pageAllPicked) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }

  /** Every control routes through here. `withQuery` resets to page 1 for
   *  anything that changes WHICH rows match — filtering down to eight rows while
   *  sitting on page 7 would otherwise show an empty table.
   *
   *  NOT wrapped in startTransition: a transition-wrapped push updates the URL
   *  but leaves the server component showing the previous query's rows, so the
   *  filter appears to do nothing. */
  /** Where a control points. Every control on this screen is a navigation to the
   *  same route with a different query, so each one is a real link: `router.push`
   *  changes the URL without re-rendering the server component, which showed the
   *  URL moving while the rows stood still.
   *
   *  `withQuery` resets to page 1 for anything that changes WHICH rows match —
   *  filtering down to eight rows while sitting on page 7 would otherwise show
   *  an empty table. */
  const hrefFor = (patch: Partial<CatalogueQuery>) =>
    `/stock${catalogueQueryToSearch(withQuery(query, patch))}`;

  return (
    <div className="space-y-4">
      {canViewCosts && aggregates.band && (
        <MoneyBand
          band={aggregates.band}
          canViewCosts={canViewCosts}
          active={query.moneyFilter}
          tileHref={(moneyFilter) => hrefFor({ moneyFilter })}
        />
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
              {/* The export is the list the reader filtered to, not the fifty
                  rows on screen — so it asks the server for the full match. */}
              <CatalogueExportBar
                count={aggregates.matchedCount}
                totalValueKes={aggregates.matchedStockValueKes}
                loadRows={() => exportCatalogueAction(query)}
                canViewCosts={canViewCosts}
              />
            </div>
          }
        />

        <CatalogueSearch
          query={query}
          matched={aggregates.matchedCount}
          clearHref={hrefFor({ search: "" })}
        />

        <HealthStrip
          total={aggregates.scopedCount}
          shown={aggregates.matchedCount}
          chips={aggregates.healthChips}
          active={query.healthFilter}
          chipHref={(key) => hrefFor({ healthFilter: query.healthFilter === key ? null : key })}
          clearHref={hrefFor({ healthFilter: null })}
          scopes={aggregates.scopeChips}
          scope={query.scope}
          // The old chip may not exist in the new scope, so it clears with it.
          scopeHref={(key) => hrefFor({ scope: key as Scope, healthFilter: null })}
        />

        <FacetFilterBar
          options={aggregates.facetOptions}
          selection={query.selection}
          selectionHref={(selection: FacetSelection) => hrefFor({ selection })}
        />

        <SortBar query={query} canViewCosts={canViewCosts} hrefFor={hrefFor} />

        <CardContent className="p-0 py-2">
          <Table>
            <TableHeader>
              {canManage && (
                <TableHead>
                  <input
                    type="checkbox"
                    className="size-4 accent-(--accent)"
                    checked={pageAllPicked}
                    onChange={togglePage}
                    aria-label={pageAllPicked ? "Deselect this page" : "Select this page"}
                  />
                </TableHead>
              )}
              <TableHead>Product</TableHead>
              <TableHead>ABC</TableHead>
              <TableHead numeric>Cost</TableHead>
              <TableHead numeric>Margin</TableHead>
              <TableHead numeric>On hand</TableHead>
              <TableHead numeric>In warehouse</TableHead>
              <TableHead numeric>En route</TableHead>
              <TableHead numeric>Sells/day</TableHead>
              <TableHead numeric>Cover</TableHead>
              <TableHead numeric>Cash tied up</TableHead>
              <TableHead numeric>Rev · 30d ({currency})</TableHead>
              <TableHead>Verdict</TableHead>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const open = expandedId === row.productId;
                return (
                  <RowGroup
                    key={row.productId}
                    row={row}
                    open={open}
                    onToggle={() => setExpandedId(open ? null : row.productId)}
                    canViewCosts={canViewCosts}
                    canManage={canManage}
                    categoryNames={categoryNames}
                    flags={ownerFlags[row.productId] ?? { active: true, activeOverride: false }}
                    picked={allMatching || picked.has(row.productId)}
                    onPick={canManage ? () => togglePicked(row.productId) : undefined}
                  />
                );
              })}
            </TableBody>
          </Table>
        </CardContent>

        {/* Offered only once the page is fully ticked and there is more beyond
            it: the rows live on the server, so "select all" on a 312-row match
            has to be a claim the server resolves, not 312 ids the browser never
            received. */}
        {canManage && pageAllPicked && !allMatching && aggregates.matchedCount > pageIds.length && (
          <p className="border-t border-edge px-4 py-2 text-sm text-ink-muted">
            All {pageIds.length} on this page are selected.{" "}
            <button
              type="button"
              onClick={() => setAllMatching(true)}
              className="font-medium text-accent-ink underline-offset-2 hover:underline"
            >
              Select all {aggregates.matchedCount} matching
            </button>
          </p>
        )}

        {pageCount > 1 && (
          <Pager
            page={page}
            pageCount={pageCount}
            from={from}
            to={from + rows.length - 1}
            total={aggregates.matchedCount}
            pageHref={(next) => hrefFor({ page: next })}
          />
        )}
      </Card>

      {canManage && selectedCount > 0 && (
        <BulkLeadTimeBar
          count={selectedCount}
          query={allMatching ? query : null}
          productIds={[...picked]}
          onDeselect={clearSelection}
          onApplied={() => {
            clearSelection();
            // The rows came from the server, so the new lead times only appear
            // once it re-renders them.
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/** Sort control. A dropdown of links rather than a select, for the same reason
 *  the chips are links: the server does the sorting, so choosing one is a
 *  navigation. Mirrors the facet bar's details/summary so the two read alike. */
function SortBar({
  query,
  canViewCosts,
  hrefFor,
}: {
  query: CatalogueQuery;
  canViewCosts: boolean;
  hrefFor: (patch: Partial<CatalogueQuery>) => string;
}) {
  const options: { key: SortKey; label: string; costOnly?: boolean }[] = [
    { key: "title", label: "Product" },
    { key: "onHandUnits", label: "On hand" },
    { key: "runRate", label: "Run rate" },
    { key: "daysCover", label: "Days cover" },
    { key: "revenue30dKes", label: "Revenue (30d)" },
    { key: "abc", label: "ABC class" },
    { key: "marginPct", label: "Margin %", costOnly: true },
    { key: "moneyAtRestKes", label: "Cash tied up", costOnly: true },
  ];
  const shown = options.filter((o) => canViewCosts || !o.costOnly);
  const current = shown.find((o) => o.key === query.sortKey) ?? shown[0]!;

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-ink-muted">
      <span>Sort</span>
      <details className="relative">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 py-1 font-medium text-ink">
          {current.label}
          <ChevronDownIcon className="size-3.5 text-ink-faint" />
        </summary>
        <div className="absolute z-10 mt-1 flex min-w-44 flex-col rounded-lg border border-edge bg-surface p-1 shadow-lg">
          {shown.map((o) => (
            <Link
              key={o.key}
              href={hrefFor({ sortKey: o.key })}
              scroll={false}
              aria-current={o.key === query.sortKey ? "true" : undefined}
              className={cn(
                "rounded-md px-2 py-1 text-left",
                o.key === query.sortKey ? "bg-accent-soft text-accent-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              {o.label}
            </Link>
          ))}
        </div>
      </details>
      <Link
        href={hrefFor({ desc: !query.desc })}
        scroll={false}
        aria-label={query.desc ? "Sort ascending" : "Sort descending"}
        className="rounded-md border border-edge bg-surface px-2 py-1 text-ink hover:bg-surface-2"
      >
        {query.desc ? "Desc ↓" : "Asc ↑"}
      </Link>
    </div>
  );
}

/** Table pager. Says how much of the matched list is on screen — a shop with
 *  400+ products must never be left guessing whether the rest is missing or
 *  merely further down — and the numbered links are the way to a far page
 *  without clicking Next eight times. */
function Pager({
  page,
  pageCount,
  from,
  to,
  total,
  pageHref,
}: {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  pageHref: (page: number) => string;
}) {
  const step = "rounded-md border border-edge bg-surface px-2 py-1 text-ink hover:bg-surface-2";
  const muted = "rounded-md border border-edge px-2 py-1 text-ink-faint opacity-50";
  // A window around the current page: a 1000-SKU catalogue is 20 pages, and
  // twenty numbers in a row is a wall rather than a control.
  const span = 2;
  const first = Math.max(0, Math.min(page - span, pageCount - (span * 2 + 1)));
  const last = Math.min(pageCount - 1, Math.max(page + span, span * 2));

  return (
    <nav
      aria-label="Catalogue pages"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-edge px-4 py-3 text-sm text-ink-muted"
    >
      <span>
        Showing {from}–{to} of {total}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {page === 0 ? (
          <span className={muted}>← Previous</span>
        ) : (
          <Link href={pageHref(page - 1)} scroll={false} className={step}>
            ← Previous
          </Link>
        )}
        {first > 0 && <span className="px-1">…</span>}
        {Array.from({ length: last - first + 1 }, (_, i) => first + i).map((n) => (
          <Link
            key={n}
            href={pageHref(n)}
            scroll={false}
            aria-label={`Page ${n + 1} of ${pageCount}`}
            aria-current={n === page ? "page" : undefined}
            className={cn(step, n === page && "border-edge-strong bg-accent-soft text-accent-ink")}
          >
            {n + 1}
          </Link>
        ))}
        {last < pageCount - 1 && <span className="px-1">…</span>}
        {page >= pageCount - 1 ? (
          <span className={muted}>Next →</span>
        ) : (
          <Link href={pageHref(page + 1)} scroll={false} className={step}>
            Next →
          </Link>
        )}
      </span>
    </nav>
  );
}

const SOURCE_SHORT: Record<string, string> = { manual: "typed", qb: "QuickBooks", shopify: "Shopify", missing: "missing" };

export function RowGroup({
  row,
  open,
  onToggle,
  canViewCosts,
  canManage,
  categoryNames,
  flags,
  picked,
  onPick,
}: {
  row: CatalogueRow;
  open: boolean;
  onToggle: () => void;
  picked: boolean;
  /** Undefined for a reader who cannot edit — no tick column at all. */
  onPick?: () => void;
  canViewCosts: boolean;
  canManage: boolean;
  categoryNames: string[];
  flags: OwnerFlags;
}) {
  // Margin reveals cost, so it masks for a money-blind member — as a bare dot
  // mask (margin is a percentage, not money), keeping the cost mask distinct.
  const marginCell = !canViewCosts ? "•••" : row.marginPct == null ? "—" : `${row.marginPct.toFixed(0)}%`;
  return (
    <>
      <TableRow className={open ? "bg-surface-2/60" : undefined}>
        {onPick && (
          <TableCell>
            <input
              type="checkbox"
              className="size-4 accent-(--accent)"
              checked={picked}
              onChange={onPick}
              aria-label={`Select ${row.title}`}
            />
          </TableCell>
        )}
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
            <span className="text-xs text-ink-faint">{row.costSource ? SOURCE_SHORT[row.costSource] : null}</span>
          </span>
        </TableCell>
        <TableCell numeric className={canViewCosts && row.marginPct != null && row.marginPct < 0 ? "font-semibold text-negative" : undefined}>
          {marginCell}
        </TableCell>
        <TableCell numeric>{row.onHandUnits}</TableCell>
        <TableCell numeric className="text-ink-muted">
          {row.warehouseUnits > 0 ? row.warehouseUnits : "—"}
        </TableCell>
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
          <td colSpan={catalogueColCount(canManage)} className="p-0">
            <RowEditor
              row={row}
              categories={categoryNames}
              flags={flags}
              canViewCosts={canViewCosts}
              canManage={canManage}
            />
            {/* The editor fixes this row; the product page explains it — a year
                of months, the supplier's lead time, and what the run decided. */}
            <div className="px-4 pb-4">
              <Link
                href={`/stock/${row.productId}`}
                className="text-sm font-medium text-accent-ink hover:underline"
              >
                See this product in full →
              </Link>
            </div>
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
