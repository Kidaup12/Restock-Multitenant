"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
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
import { formatNumber } from "@/lib/money";
import type { CatalogueRow } from "@/lib/data/stock";
import type { DashboardTab, DashboardTable } from "@/lib/data/today";

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
  { key: "all", label: "All" },
];

const EMPTY: Record<DashboardTab, string> = {
  stockout: "Nothing is out of stock.",
  reorder: "Nothing needs reordering right now.",
  onway: "Nothing is on its way in.",
  dead: "No stock is sitting unsold.",
  all: "No products yet.",
};

function eta(date: Date | null): string {
  if (!date) return "no ETA";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(date));
}

function cover(row: CatalogueRow): string {
  // An empty shelf has no cover to report, and a product with no run rate never
  // runs out — neither is a number of days.
  if (row.onHandUnits <= 0 || row.daysCover == null) return "—";
  return `${row.daysCover}d`;
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
  trend,
}: {
  data: DashboardTable;
  canViewCosts: boolean;
  /** The revenue chart, rendered on the server and placed here so it can sit
   *  beside the health list without either needing the other's data. */
  trend: ReactNode;
}) {
  const [tab, setTab] = useState<DashboardTab>("stockout");
  const rows = data.rows[tab];

  const health: { label: string; count: number; key: DashboardTab; tone: string }[] = [
    { label: "Healthy cover", count: data.healthy, key: "all", tone: "text-positive" },
    { label: "Stockouts", count: data.counts.stockout, key: "stockout", tone: "text-negative" },
    { label: "Reorder needed", count: data.counts.reorder, key: "reorder", tone: "text-warning" },
    { label: "On the way", count: data.counts.onway, key: "onway", tone: "text-accent-ink" },
    {
      label: `Not selling · ${data.deadWindowDays}d`,
      count: data.counts.dead,
      key: "dead",
      tone: "text-ink-muted",
    },
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
        </div>

        <div className="mt-3 pb-2">
          {rows.length === 0 ? (
            <div className="px-5 pb-4">
              <EmptyState icon={<BoxIcon />} title={EMPTY[tab]} />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                {tab === "onway" ? (
                  <>
                    <TableHead numeric>Incoming</TableHead>
                    <TableHead>Arrives</TableHead>
                    <TableHead numeric>Stock now</TableHead>
                  </>
                ) : tab === "dead" ? (
                  <>
                    <TableHead numeric>Stock</TableHead>
                    <TableHead numeric>Cost / unit</TableHead>
                    <TableHead numeric>Capital tied up</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead numeric>Stock</TableHead>
                    <TableHead numeric>Run/day</TableHead>
                    <TableHead numeric>Cover</TableHead>
                    <TableHead numeric>En route</TableHead>
                  </>
                )}
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <Link
                        href={`/products/${row.productId}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {row.title}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-ink-muted">
                        {row.sku}
                        {row.abc && (
                          <Badge tone="neutral" className="font-sans">
                            {row.abc}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    {tab === "onway" ? (
                      <>
                        <TableCell numeric>{formatNumber(row.onOrderUnits)}</TableCell>
                        <TableCell>{eta(row.expectedArrivalAt)}</TableCell>
                        <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                      </>
                    ) : tab === "dead" ? (
                      <>
                        <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
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
                        <TableCell numeric>
                          {/* Same presentation as the catalogue: two places, and a
                              dash rather than 0.00 for something that is not moving. */}
                          {row.runRate > 0 ? row.runRate.toFixed(2) : "—"}
                        </TableCell>
                        <TableCell numeric>{cover(row)}</TableCell>
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
