"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { Pager } from "@/components/ui/pager";
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
  catalogueQueryFields,
  catalogueQueryToSearch,
  withQuery,
  type CatalogueQuery,
  type Scope,
  type SortKey,
} from "@/lib/catalogue";
import type { CatalogueRow, CatalogueScreen, CategoryUsage } from "@/lib/data/stock";
import { TableSearch } from "@/components/ui/table-search";
import { BulkLeadTimeBar } from "./bulk-lead-time-bar";
import { FacetFilterBar } from "./facet-filter-bar";
import { CatalogueExportBar } from "./catalogue-export";
import { HealthStrip } from "./health-strip";
import { MoneyBand } from "./money-band";
import { ManageCategories } from "./manage-categories";
import { RowEditor } from "./row-editor";
import { exportCatalogueAction, setLeadTimeForProductsAction } from "./actions";
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
 *  The data columns are fixed — Product · ABC · Supplier · Lead · Cost · Margin ·
 *  On hand · In warehouse · En route · Sells/day · Cover · Cash tied up ·
 *  Revenue · Verdict — and only the tick column an editor sees varies. Derived
 *  in one place so the count cannot drift from the header. */
export function catalogueColCount(canManage: boolean): number {
  return 14 + (canManage ? 1 : 0);
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
    `/products${catalogueQueryToSearch(withQuery(query, patch))}`;

  /**
   * A column heading that sorts, matching the inventory table.
   *
   * Clicking the column you are already on flips the direction; clicking a new
   * one opens on the order people actually ask that column for. Nobody opens a
   * catalogue wanting the least stock or the healthiest cover first — so
   * quantities and money start high-to-low, and cover, margin and lead start
   * low-to-high, where the trouble is.
   */
  const SortableHead = ({
    label,
    sortKey,
    numeric,
    startAsc,
  }: {
    label: string;
    sortKey: SortKey;
    numeric?: boolean;
    startAsc?: boolean;
  }) => {
    const active = query.sortKey === sortKey;
    return (
      <TableHead numeric={numeric}>
        <Link
          href={hrefFor({ sortKey, desc: active ? !query.desc : !startAsc })}
          scroll={false}
          aria-label={`Sort by ${label}${active && !query.desc ? ", descending" : ", ascending"}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm hover:text-ink",
            active ? "text-ink" : "text-ink-muted",
          )}
        >
          {label}
          {/* Only the active column shows an arrow. A caret on every heading
              says "sortable" and stops saying "sorted by this". */}
          {active && <span aria-hidden>{query.desc ? "↓" : "↑"}</span>}
        </Link>
      </TableHead>
    );
  };

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

        <TableSearch
          action="/products"
          value={query.search}
          hidden={catalogueQueryFields(query)}
          placeholder="Search by product, SKU, variant, brand or category"
          label="Search the catalogue"
          matched={aggregates.matchedCount}
          unit="product"
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

        {/* Class, promoted out of the facet dropdown onto the surface.
            It was always filterable, but a buyer's first question of a
            catalogue is "show me the ones that earn" and that should not need
            two clicks and a menu to reach. */}
        <ClassChips
          options={aggregates.facetOptions.abc}
          selected={query.selection.abc ?? []}
          hrefFor={(abc) =>
            hrefFor({ selection: { ...query.selection, ...(abc ? { abc } : { abc: undefined }) } })
          }
        />

        <FacetFilterBar
          options={aggregates.facetOptions}
          selection={query.selection}
          selectionHref={(selection: FacetSelection) => hrefFor({ selection })}
        />

        <CardContent className="p-0 py-2">
          <Table dense>
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
              <SortableHead label="Product" sortKey="title" startAsc />
              <SortableHead label="ABC" sortKey="abc" startAsc />
              <SortableHead label="Supplier" sortKey="supplierName" startAsc />
              <SortableHead label="Lead" sortKey="leadDays" numeric startAsc />
              <SortableHead label="Cost" sortKey="costKes" numeric />
              <SortableHead label="Margin" sortKey="marginPct" numeric startAsc />
              <SortableHead label="On hand" sortKey="onHandUnits" numeric />
              <SortableHead label="In warehouse" sortKey="warehouseUnits" numeric />
              <SortableHead label="En route" sortKey="onOrderUnits" numeric />
              <SortableHead label="Sells/day" sortKey="runRate" numeric />
              <SortableHead label="Cover" sortKey="daysCover" numeric startAsc />
              <SortableHead label="Cash tied up" sortKey="moneyAtRestKes" numeric />
              <SortableHead label={`Rev · 30d (${currency})`} sortKey="revenue30dKes" numeric />
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

/**
 * The ABC classes, as one-click chips with their counts.
 *
 * Named by what they earn rather than by their letter. "Class A" is jargon a
 * shop owner has to be taught; "best sellers" is the thing they already think
 * about, and the letter stays beside it for anyone who has learnt it.
 *
 * These write the same `abc` facet the filter bar does — one filter, two ways
 * in — so the chip and the dropdown can never disagree about what is selected.
 */
export function ClassChips({
  options,
  selected,
  hrefFor,
}: {
  options: { value: string; label: string; count: number }[];
  selected: string[];
  hrefFor: (abc: string[] | undefined) => string;
}) {
  if (options.length === 0) return null;

  const NAMES: Record<string, string> = {
    A: "Best sellers",
    B: "Steady sellers",
    C: "Slow movers",
  };
  const total = options.reduce((n, o) => n + o.count, 0);

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
      <Link
        href={hrefFor(undefined)}
        scroll={false}
        aria-current={selected.length === 0 ? "true" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors",
          selected.length === 0
            ? "border-accent-200 bg-accent-soft text-accent-ink"
            : "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink",
        )}
      >
        All
        <span className="rounded-xs bg-surface-2/70 px-1.5 font-mono tabular-nums">{total}</span>
      </Link>
      {options.map((opt) => {
        const on = selected.includes(opt.value);
        return (
          <Link
            key={opt.value}
            href={hrefFor(on ? undefined : [opt.value])}
            scroll={false}
            aria-current={on ? "true" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors",
              on
                ? "border-accent-200 bg-accent-soft text-accent-ink"
                : "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {NAMES[opt.value] ?? opt.label}
            <span className="rounded-xs bg-surface-2/70 px-1.5 font-mono tabular-nums">
              {opt.count}
            </span>
          </Link>
        );
      })}
    </div>
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
        <TableCell className="max-w-[10rem] truncate text-ink-muted">
          {row.supplierName ?? "—"}
        </TableCell>
        <TableCell numeric>
          <LeadCell row={row} canManage={canManage} />
        </TableCell>
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
                href={`/products/${row.productId}`}
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

/**
 * The lead time this product's reorder maths runs on, editable in place.
 *
 * It shows where the number came from as well as what it is. Every row resolves
 * to some figure — the product's own, else its supplier's, else a flat
 * assumption — and a 14 nobody chose looks exactly like a 14 the shop measured.
 * Only the first is worth trusting, and only the assumed one is a job, so the
 * origin rides alongside the number rather than being flattened out of it.
 *
 * Editing writes through the same action the bulk bar uses, which until now was
 * the only way to set a lead time from this screen: a control whose effect the
 * table never showed.
 */
function LeadCell({ row, canManage }: { row: CatalogueRow; canManage: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(row.leadDays));
  const [pending, start] = useTransition();

  const inherited = row.leadSource !== "product";
  const hint =
    row.leadSource === "product"
      ? "Set on this product"
      : row.leadSource === "supplier"
        ? `From ${row.supplierName ?? "the supplier"}`
        : "Assumed — nobody has set this";

  function save() {
    setEditing(false);
    const typed = value.trim();
    const days = typed === "" ? null : Number(typed);
    if (days != null && (!Number.isFinite(days) || days < 0 || days > 365)) {
      setValue(String(row.leadDays));
      return;
    }
    // Clearing it hands the row back to its supplier's lead time, so a blank is
    // a real choice rather than a no-op — only an unchanged product override is.
    if (days === row.leadDays && row.leadSource === "product") return;
    start(async () => {
      const result = await setLeadTimeForProductsAction({
        leadTimeDays: days,
        productIds: [row.productId],
      });
      if (result.ok) router.refresh();
      else setValue(String(row.leadDays));
    });
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        min={0}
        max={365}
        value={value}
        aria-label={`Lead time for ${row.title}, in days`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setValue(String(row.leadDays));
            setEditing(false);
          }
        }}
        className="w-16 rounded-sm border border-accent px-1.5 py-0.5 text-right text-sm tabular-nums"
      />
    );
  }

  const label = `${row.leadDays}d`;
  if (!canManage) {
    return (
      <span title={hint} className={inherited ? "text-ink-faint" : "text-ink-muted"}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setValue(String(row.leadDays));
        setEditing(true);
      }}
      title={`${hint} — click to change`}
      className={cn(
        "underline decoration-dotted underline-offset-2 hover:text-ink",
        inherited ? "text-ink-faint" : "text-ink-muted",
      )}
    >
      {pending ? "…" : label}
    </button>
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
