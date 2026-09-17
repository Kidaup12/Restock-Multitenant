"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { AbcBadge } from "@/components/ui/abc-badge";
import { Card } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { DaysLeft } from "@/components/ui/days-left";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GLOSSARY, InfoDot } from "@/components/ui/term";
import { formatNumber, formatRunRate } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import { cn } from "@/lib/cn";
import type { BuyListRow } from "@/lib/data/plan";
import { moqPreview } from "@/lib/plan/moq-preview";
import { LeadFlooredNote } from "./lead-floored-note";
import {
  MoqNote,
  QtyCell,
  TrustChips,
  WhyPanel,
  dayLabel,
  sortRows,
  type SortKey,
} from "./buy-checklist";

/**
 * The one flat, sortable buy-list table.
 *
 * Modelled on the reference app's `BuyListTable` — a single scannable table
 * ranked by whatever the reader asks for, rather than three separate tier cards.
 * Built entirely from THIS repo's design system: the shared `Table` primitives,
 * `Badge`, `AbcBadge`, `CostValue` (money-blind redaction), `DaysLeft`, and the
 * plan's own `QtyCell` / `WhyPanel` / `MoqNote` / `TrustChips`.
 *
 * Sorting is client state (like the checklist's `SortKey`), and the active sort
 * is echoed in the card title so the list always says how it is ranked. Clicking
 * a numeric header sets that column's sort. The whole row toggles selection; the
 * checkbox and the product link stop propagation so they still do their own job.
 *
 * The urgency badge rides beside the title (as in the reference) rather than in
 * its own column, and the card footer carries the grand total through the same
 * `CostValue` seam so a money-blind member sees the mask, not a number.
 */

/** How the active sort reads in the card title — one phrase per key, so the
 *  header always states its own order. */
const SORT_TITLE: Partial<Record<SortKey, string>> = {
  urgent: "most urgent first",
  fastest: "fastest-selling first",
  revenue: "highest 30d revenue first",
  costly: "biggest line total first",
  earners: "top earners first",
  alpha: "A → Z",
};

/**
 * A numeric column heading that sorts on click.
 *
 * The checklist keeps its sort in React state (not the URL), so this is a plain
 * button rather than the URL-driven `SortableHead` — but it lands in the same
 * `TableHead` and carries the same `aria-sort`, so a reader who cannot see the
 * arrow still hears which way the column is ordered.
 */
function SortHeaderButton({
  label,
  sortKey,
  activeKey,
  onSort,
  title,
  hint,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  onSort: (key: SortKey) => void;
  /** Native tooltip on the header cell. */
  title?: string;
  /** When set, adds a visible "i" affordance beside the label. */
  hint?: string;
}) {
  const active = activeKey === sortKey;
  return (
    <TableHead numeric sort={active ? "descending" : "none"}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm hover:text-ink",
          active ? "text-ink" : "text-ink-muted"
        )}
      >
        {label}
        {hint && <InfoDot hint={hint} />}
        {active && <span aria-hidden>↓</span>}
      </button>
    </TableHead>
  );
}

export function BuyTable({
  rows,
  canViewCosts,
  canOverride,
  picked,
  onToggle,
  sort,
  onSortChange,
  showOrderBy = false,
  title = "Buy list",
  totalLabel = "Order cost · at supplier cost",
  footerTotalKes,
}: {
  /** Already scoped, urgency-filtered and (optionally) what-if re-sized by the
   *  parent — this table only re-orders them. */
  rows: BuyListRow[];
  canViewCosts: boolean;
  canOverride: boolean;
  /** The picked set and its toggle, shared with the parent's order picker so the
   *  running total and the action bar agree with what is ticked here. */
  picked: Set<string>;
  onToggle: (predictionId: string) => void;
  /** Sort is owned by the parent so the "N products to order" line and this
   *  table read one order. */
  sort: SortKey;
  onSortChange: (key: SortKey) => void;
  /** Add the "Order by" column — the recommended-purchase view wants the date. */
  showOrderBy?: boolean;
  title?: string;
  totalLabel?: string;
  /** The card-footer grand total, masked through CostValue. Null for a
   *  money-blind member (the field the parent sums is already null). */
  footerTotalKes: number | null;
}) {
  const currency = useCurrency();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const shown = sortRows(rows, sort);

  const activeTitle = SORT_TITLE[sort];

  function toggleExpanded(id: string) {
    setExpanded((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // checkbox | Product | Buying at/day | Rev 30d | Days left | [Order by] |
  // Stock | En route | Qty | Line total | why-chevron
  const colCount = showOrderBy ? 11 : 10;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-4">
        <h2 className="text-base font-semibold tracking-tight text-ink">
          {title}
          {activeTitle && <span className="font-normal text-ink-muted"> · {activeTitle}</span>}
        </h2>
      </div>

      <Table className="min-w-[720px]" dense>
        <TableHeader>
          <TableHead className="w-10">
            <span className="sr-only">Tick to order</span>
          </TableHead>
          <TableHead>Product</TableHead>
          {/* KEEP this label. The one-name-per-rate rule (see
              tests/one-name-per-rate.test.ts) forbids the catalogue's rate name
              here, because this is the rate the order was sized from, not what
              the shelf did. The header carries a tooltip + info dot, and the
              column sorts fastest-selling. */}
          <SortHeaderButton
            label="Buying at/day"
            sortKey="fastest"
            activeKey={sort}
            onSort={onSortChange}
            title={`${GLOSSARY.runRate.hint} · click to sort`}
            hint={GLOSSARY.runRate.hint}
          />
          <SortHeaderButton
            label={`Rev 30d (${currency})`}
            sortKey="revenue"
            activeKey={sort}
            onSort={onSortChange}
            title="Actual revenue this product earned in the last 30 days · click to sort"
          />
          <TableHead numeric>Days left</TableHead>
          {showOrderBy && (
            <TableHead numeric>
              Order by
              <InfoDot hint={GLOSSARY.orderBy.hint} />
            </TableHead>
          )}
          <TableHead numeric>Stock</TableHead>
          <TableHead numeric>
            En route
            <InfoDot hint={GLOSSARY.enRoute.hint} />
          </TableHead>
          <TableHead numeric>Qty</TableHead>
          <TableHead numeric>Line total</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">Show reasoning</span>
          </TableHead>
        </TableHeader>
        <TableBody>
          {shown.length === 0 && (
            <tr className="border-b border-edge last:border-0">
              <td colSpan={colCount} className="px-5 py-8 text-center text-sm text-ink-muted">
                Nothing to buy in this list.
              </td>
            </tr>
          )}
          {shown.map((row) => {
            const isPicked = picked.has(row.predictionId);
            const isOpen = expanded.has(row.predictionId);
            // Overdue keys off the run-date-relative days-left (stable across
            // SSR/hydration), not a live clock: <= 0 means the order-by day is
            // here or past.
            const overdue = row.daysLeftToOrder <= 0;
            const urgent = row.urgency === "critical" || row.urgency === "high";
            return (
              <Fragment key={row.predictionId}>
                <TableRow
                  onClick={() => onToggle(row.predictionId)}
                  className={cn(
                    "cursor-pointer",
                    isPicked && "bg-accent-soft/40",
                    isOpen && "border-b-0"
                  )}
                >
                  {/* The whole row toggles selection; only the interactive
                      children below stop the bubble. */}
                  <TableCell className="w-10">
                    <input
                      type="checkbox"
                      checked={isPicked}
                      onChange={() => onToggle(row.predictionId)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Order ${row.title}`}
                      className="size-4 accent-accent"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/products/${row.productId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-sm font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {row.title}
                      </Link>
                      {/* Urgency rides with the title, not in its own column. */}
                      {urgent && (
                        <Badge tone={row.urgency === "critical" ? "critical" : "warning"}>
                          {row.urgency === "critical" ? "Critical" : "Order now"}
                        </Badge>
                      )}
                      <AbcBadge value={row.abc} />
                      <TrustChips row={row} />
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-ink-muted">
                      {row.sku}
                      {row.supplierName ? ` · ${row.supplierName}` : ""}
                      {row.plannable !== "ok" && (
                        <Badge tone="warning" className="ml-2 font-sans">
                          Check cost
                        </Badge>
                      )}
                      {row.doubleOrderWarn && (
                        <Badge tone="warning" className="ml-2 font-sans">
                          also on a draft PO
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell numeric>
                    {formatRunRate(row.runRatePerDay)}
                  </TableCell>
                  <TableCell numeric>
                    {/* Revenue is a sales figure — plain amount, unit in the
                        header — shown to every role. */}
                    {row.revenue30dKes > 0 ? formatNumber(row.revenue30dKes) : "—"}
                  </TableCell>
                  <TableCell numeric>
                    <DaysLeft days={row.daysUntilStockout} onHandUnits={row.onHandUnits} />
                  </TableCell>
                  {showOrderBy && (
                    <TableCell numeric>
                      {overdue ? (
                        <span className="font-medium text-negative">{dayLabel(row.orderByDate)}</span>
                      ) : (
                        dayLabel(row.orderByDate)
                      )}
                    </TableCell>
                  )}
                  <TableCell numeric>
                    {formatNumber(row.onHandUnits)}
                  </TableCell>
                  <TableCell numeric>
                    {row.onOrderUnits > 0 ? formatNumber(row.onOrderUnits) : "—"}
                  </TableCell>
                  <TableCell numeric>
                    <div className="flex flex-col items-end gap-0.5">
                      <QtyCell row={row} canOverride={canOverride} />
                      <MoqNote preview={moqPreview(row)} />
                      {row.leadFloored && <LeadFlooredNote leadDays={row.leadDays} />}
                    </div>
                  </TableCell>
                  <TableCell numeric>
                    <CostValue amount={row.lineTotalKes} canViewCosts={canViewCosts} />
                  </TableCell>
                  <TableCell className="w-10">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(row.predictionId);
                      }}
                      aria-expanded={isOpen}
                      aria-label={`Why ${row.recommendedQty} units of ${row.title}`}
                      className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <ChevronDownIcon
                        className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                      />
                    </button>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <tr className="border-b border-edge last:border-0">
                    <td colSpan={colCount} className="px-5 pt-0 pb-4">
                      <WhyPanel row={row} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between gap-3 border-t border-edge bg-surface-2/40 px-5 py-4">
        <span className="text-2xs font-semibold tracking-wider text-ink-muted uppercase">
          {totalLabel}
        </span>
        <CostValue
          amount={footerTotalKes}
          canViewCosts={canViewCosts}
          className="font-mono text-xl font-semibold tracking-tight text-ink"
        />
      </div>
    </Card>
  );
}
