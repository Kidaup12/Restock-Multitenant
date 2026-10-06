"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AbcBadge } from "@/components/ui/abc-badge";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { BoxIcon } from "@/components/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatNumber, formatRunRate } from "@/lib/money";
import type { CatalogueRow } from "@/lib/data/stock";
import type { DashboardTab, DashboardTable } from "@/lib/data/today";
import { DeadStockExportBar } from "./dead-stock-export";
import { UnsoldStockExport } from "@/components/inventory/unsold-export";
import { UNSOLD_STATUS_LABELS } from "@/lib/inventory/unsold-labels";
import { CostFixer } from "../plan/cost-fixer";

/**
 * The morning's products, in the five piles worth looking at, with the four
 * figures that name them sitting above as the way in.
 *
 * The cards and the health list SELECT a pile rather than navigating: every
 * pile is already on the client, so making them links would cost a round trip
 * to show something already here. Counts come from the server's full counts,
 * never the length of the capped rows — reporting the cap is how a dashboard
 * ends up saying "8" on a morning the planner says 14.
 */

const TABS: { key: DashboardTab; label: string }[] = [
  { key: "stockout", label: "Stockout" },
  { key: "reorder", label: "Reorder" },
  { key: "onway", label: "On the way" },
  // Their label, and the clearer one: "Dead" alone reads as a verdict on the
  // product rather than on the money sitting in it.
  { key: "dead", label: "Dead stock" },
  { key: "unsold", label: "Unsold" },
  { key: "all", label: "All" },
];

const EMPTY: Record<DashboardTab, string> = {
  stockout: "Nothing is out of stock.",
  reorder: "Nothing needs reordering right now.",
  onway: "Nothing is on its way in.",
  dead: "No stock currently meets the dead-stock rules.",
  unsold: "Every stocked product has a recorded sale.",
  all: "No products yet.",
};

export const UNSOLD_REASON_LABELS = UNSOLD_STATUS_LABELS;

function eta(date: Date | null): string {
  if (!date) return "no ETA";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(date));
}

function daysLeft(row: CatalogueRow): string {
  // An empty shelf has NO days left, and saying so is the point of the column —
  // a dash reads as "unknown" on exactly the rows where the answer is known and
  // urgent. A product with no run rate still gets the dash: it never runs out,
  // which is a different thing from running out today.
  if (row.onHandUnits <= 0) return "0d";
  if (row.daysCover == null) return "—";
  return `${row.daysCover}d`;
}

/** The row's standing, in one word, for the pile it is sitting in.
 *
 *  An empty shelf and a shelf about to empty are the same colour of problem but
 *  not the same job — one is lost sales now, the other is a purchase order
 *  today — and the ABC badge beside it says nothing about either. */
function standing(row: CatalogueRow): { label: string; tone: "negative" | "warning" } | null {
  if (row.onHandUnits <= 0) return { label: "out", tone: "negative" };
  if (row.urgency === "critical") return { label: "critical", tone: "negative" };
  if (row.urgency === "high") return { label: "low", tone: "warning" };
  return null;
}

function KpiCard({
  label,
  value,
  hint,
  tone,
  active,
  onSelect,
}: {
  label: string;
  value: ReactNode;
  hint: string;
  tone?: "negative" | "warning" | "accent";
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "rounded-lg border bg-surface p-5 text-left shadow-card transition-colors",
        active ? "border-accent-300 bg-accent-soft/40" : "border-edge hover:border-edge-strong"
      )}
    >
      <div className="text-2xs tracking-wider text-ink-muted uppercase">{label}</div>
      <div
        className={cn(
          "mt-1.5 font-mono text-3xl font-semibold tracking-tight",
          tone === "negative" && "text-negative",
          tone === "warning" && "text-warning",
          tone === "accent" && "text-accent-ink",
          !tone && "text-ink"
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-2xs text-ink-muted">{hint} →</div>
    </button>
  );
}

export function ProductTabs({
  data,
  canViewCosts,
  canOverride = false,
  trend,
}: {
  data: DashboardTable;
  canViewCosts: boolean;
  /** Whether this caller can act on cost/price (approve_orders), the same gate
   *  the Plan page's CostFixer uses. Without it the missing-cost notice only
   *  links out to the product page. Defaults false so every existing test
   *  fixture that doesn't pass it keeps today's link-out behaviour. */
  canOverride?: boolean;
  /** The revenue chart, rendered on the server and placed here so it can sit
   *  beside the health list without either needing the other's data. */
  trend: ReactNode;
}) {
  const [tab, setTab] = useState<DashboardTab>("stockout");
  const [unsoldSearch, setUnsoldSearch] = useState("");
  const [fixedIds, setFixedIds] = useState<Set<string>>(new Set());
  const rows = tab === "unsold" && unsoldSearch.trim()
    ? data.rows.unsold.filter(row => `${row.title} ${row.sku} ${row.vendor ?? ""}`.toLowerCase().includes(unsoldSearch.trim().toLowerCase()))
    : data.rows[tab];

  const health: { label: string; count: number; key: DashboardTab; tone: string }[] = [
    { label: "Other stocked products", count: data.healthy, key: "all", tone: "text-ink-muted" },
    { label: "Stockouts", count: data.counts.stockout, key: "stockout", tone: "text-negative" },
    { label: "Reorder needed", count: data.counts.reorder, key: "reorder", tone: "text-warning" },
    { label: "On the way", count: data.counts.onway, key: "onway", tone: "text-accent-ink" },
    {
      label: `Not selling · ${data.deadWindowDays}d`,
      count: data.counts.dead,
      key: "dead",
      tone: "text-ink-muted",
    },
    { label: "Unsold · no recorded sales", count: data.counts.unsold, key: "unsold", tone: "text-ink-muted" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Stockouts"
          value={formatNumber(data.counts.stockout)}
          hint="the shelf is empty"
          tone={data.counts.stockout > 0 ? "negative" : undefined}
          active={tab === "stockout"}
          onSelect={() => setTab("stockout")}
        />
        <KpiCard
          label="Reorders needed"
          value={formatNumber(data.counts.reorder)}
          hint={`of ${formatNumber(data.counts.all)} tracked`}
          tone={data.counts.reorder > 0 ? "warning" : undefined}
          active={tab === "reorder"}
          onSelect={() => setTab("reorder")}
        />
        <KpiCard
          label="On the way"
          value={formatNumber(data.counts.onway)}
          hint="inbound to the shelf"
          tone="accent"
          active={tab === "onway"}
          onSelect={() => setTab("onway")}
        />
        <KpiCard
          label="Dead stock"
          // The cash leads for a reader allowed to see it: this and the stockout
          // count are the two figures the shop judges the product by, and "9
          // SKUs" does not say what it is costing. A money-blind member gets the
          // count, which is the part of the answer they may have.
          value={
            canViewCosts ? (
              <CostValue amount={data.deadCostKes} canViewCosts={canViewCosts} compact />
            ) : (
              formatNumber(data.counts.dead)
            )
          }
          hint={`${formatNumber(data.counts.dead)} SKUs, no sale in ${data.deadWindowDays} days`}
          tone={canViewCosts && data.counts.dead > 0 ? "warning" : undefined}
          active={tab === "dead"}
          onSelect={() => setTab("dead")}
        />
      </div>

      <Card className="p-4 sm:p-5">
        <button type="button" aria-pressed={tab === "unsold"} onClick={() => setTab("unsold")}
          className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 rounded text-left hover:text-accent-ink">
          <span className="min-w-0">
            <span className="block font-semibold">Unsold · {formatNumber(data.counts.unsold)} stocked products</span>
            <span className="mt-1 block text-sm text-ink-muted">No recorded positive sales. View the full list →</span>
          </span>
          {canViewCosts && <span className="text-right font-mono text-xl font-semibold">
            <CostValue amount={data.unsoldSummary.costKes} canViewCosts={canViewCosts} compact />
            <span className="block font-sans text-xs font-normal text-ink-muted">stock value at cost</span>
          </span>}
        </button>
        <p className="mt-3 text-sm text-ink-muted">Recent product records, including recently imported records, may still be in the 60-day grace period. Others need more stock history or a known age before they qualify as dead stock. This list includes any products already counted as dead stock; the two values should not be added together.</p>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        {trend}
        <Card>
          <CardHeader
            title="Inventory health"
            subtitle={`${formatNumber(data.counts.all)} tracked products`}
          />
          <div className="px-2 pt-1 pb-3">
            {health.map((row) => (
              <button
                key={row.label}
                type="button"
                onClick={() => setTab(row.key)}
                aria-pressed={tab === row.key}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
                  tab === row.key ? "bg-surface-2" : "hover:bg-surface-2/60"
                )}
              >
                <span className="text-ink-secondary">{row.label}</span>
                <span className={cn("font-mono font-medium", row.tone)}>
                  {formatNumber(row.count)}
                </span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 px-5 pt-5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={cn(
                "flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors",
                tab === t.key
                  ? "border-accent-200 bg-accent-soft text-accent-ink"
                  : "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink"
              )}
            >
              {t.label}
              <span className="rounded-xs bg-surface-2/70 px-1.5 font-mono tabular-nums">
                {formatNumber(data.counts[t.key])}
              </span>
            </button>
          ))}
          {data.capped[tab] && (
            <span className="ml-auto text-2xs text-ink-muted">
              showing the first {rows.length} of {formatNumber(data.counts[tab])}
            </span>
          )}
          {/* The download is the whole dead pile, not the capped page above —
              offered on this tab only, where the file has a definition. */}
          {tab === "dead" && data.deadStockExport.length > 0 && (
            <div className={data.capped[tab] ? "" : "ml-auto"}>
              <DeadStockExportBar rows={data.deadStockExport} canViewCosts={canViewCosts} />
            </div>
          )}
          {tab === "unsold" && <div className="ml-auto">
            <UnsoldStockExport rows={rows} reasons={data.unsoldReasons} canViewCosts={canViewCosts} />
          </div>}
        </div>

        {tab === "unsold" && <div className="space-y-2 px-5 pt-4">
          <Input aria-label="Search unsold products" placeholder="Search unsold products by name, SKU or brand" value={unsoldSearch} onChange={event => setUnsoldSearch(event.target.value)} className="w-full sm:max-w-md" />
          <p className="text-sm text-ink-muted">Showing {formatNumber(rows.length)} of {formatNumber(data.counts.unsold)} stocked products with no recorded sale. Every matching product is included; scroll within the table to see the full list.</p>
        </div>}

        {/* The run sizes these too — never held back for a missing supplier,
            only for unit economics it can't reason about. Shown on Reorder so
            "why isn't this stockout here" has an answer instead of a silent
            omission; fix the cost on the product, not the supplier. The fixer
            is inline here (not just a link to the product page) because the
            whole point of the card is that fixing a cost should take one
            click, not a navigation. */}
        {tab === "reorder" && data.missingCostCount > 0 && (() => {
          const remaining = data.missingCostRows.filter(row => !fixedIds.has(row.productId));
          const remainingCount = data.missingCostCount - fixedIds.size;
          if (remainingCount <= 0) return null;
          return (
            <div className="mx-5 mt-4 rounded-lg border-2 border-warning bg-warning-soft p-4 text-sm shadow-sm">
              <p className="font-semibold text-warning">
                {formatNumber(remainingCount)} more product{remainingCount === 1 ? "" : "s"} need{remainingCount === 1 ? "s" : ""} a cost before they can be forecasted
              </p>
              <p className="mt-1 text-ink-muted">Missing or broken cost data — these are not on this list until the number is fixed, whether or not a supplier is set.</p>
              <ul className="mt-3 space-y-2">
                {remaining.slice(0, 6).map(row => (
                  <li key={row.productId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-md bg-surface-1/70 px-3 py-2">
                    <span className="min-w-0">
                      <Link href={`/products/${row.productId}`} className="rounded-sm font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                        {row.title}
                      </Link>
                      <span className="ml-1.5 font-mono text-xs text-ink-muted">{row.sku}</span>
                    </span>
                    {canOverride && canViewCosts ? (
                      <CostFixer
                        productId={row.productId}
                        plannable={row.plannable}
                        onFixed={() => setFixedIds(prev => new Set(prev).add(row.productId))}
                      />
                    ) : (
                      <Link href={`/products/${row.productId}`} className="text-xs font-medium text-accent-ink hover:underline">
                        Fix cost →
                      </Link>
                    )}
                  </li>
                ))}
                {remainingCount > 6 && (
                  <li className="px-3 text-ink-muted">+{formatNumber(remainingCount - 6)} more</li>
                )}
              </ul>
            </div>
          );
        })()}

        <div className="mt-3 pb-2">
          {rows.length === 0 ? (
            <div className="px-5 pb-4">
              <EmptyState icon={<BoxIcon />} title={tab === "unsold" && unsoldSearch.trim() ? "No unsold products match this search." : EMPTY[tab]} />
            </div>
          ) : (
            <Table boxed={tab === "unsold"}>
              <TableHeader>
                <TableHead>Product</TableHead>
                {tab === "onway" ? (
                  <>
                    <TableHead numeric>Incoming</TableHead>
                    <TableHead>Arrives</TableHead>
                    <TableHead numeric>Stock now</TableHead>
                    <TableHead numeric>Sells/day</TableHead>
                  </>
                ) : tab === "dead" || tab === "unsold" ? (
                  <>
                    <TableHead numeric>Stock</TableHead>
                    {tab === "unsold" ? <TableHead>Dead-stock status</TableHead> : <TableHead numeric>Sells/day</TableHead>}
                    <TableHead numeric>Cost / unit</TableHead>
                    <TableHead numeric>Capital tied up</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead numeric>Stock</TableHead>
                    <TableHead numeric>Sells/day</TableHead>
                    <TableHead numeric>Days left</TableHead>
                    <TableHead numeric>En route</TableHead>
                  </>
                )}
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell className={tab === "unsold" ? "min-w-48 max-w-80 whitespace-normal wrap-break-word" : undefined}>
                      <Link
                        href={`/products/${row.productId}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {row.title}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-ink-muted">
                        {row.sku}
                        {/* The brand is how a buyer recognises the product and
                            groups an order; a SKU code alone is the one thing
                            on the row nobody knows by heart. */}
                        {row.vendor && <span className="font-sans">· {row.vendor}</span>}
                        <AbcBadge value={row.abc} />
                        {(() => {
                          const s = standing(row);
                          return s ? (
                            <Badge tone={s.tone} className="font-sans">
                              {s.label}
                            </Badge>
                          ) : null;
                        })()}
                      </div>
                    </TableCell>
                    {tab === "onway" ? (
                      <>
                        <TableCell numeric>{formatNumber(row.onOrderUnits)}</TableCell>
                        <TableCell>{eta(row.expectedArrivalAt)}</TableCell>
                        <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                        <TableCell numeric>{formatRunRate(row.runRate)}</TableCell>
                      </>
                    ) : tab === "dead" || tab === "unsold" ? (
                      <>
                        <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                        {tab === "unsold" ? <TableCell className="max-w-64 whitespace-normal">{UNSOLD_REASON_LABELS[data.unsoldReasons[row.productId]]}</TableCell> : <TableCell numeric>{formatRunRate(row.runRate)}</TableCell>}
                        <TableCell numeric>
                          <CostValue amount={row.costKes} canViewCosts={canViewCosts} />
                        </TableCell>
                        <TableCell numeric>
                          <CostValue amount={row.moneyAtRestKes} canViewCosts={canViewCosts} />
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                        <TableCell numeric>{formatRunRate(row.runRate)}</TableCell>
                        <TableCell numeric>{daysLeft(row)}</TableCell>
                        <TableCell numeric>
                          {row.onOrderUnits > 0 ? formatNumber(row.onOrderUnits) : "—"}
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  );
}
