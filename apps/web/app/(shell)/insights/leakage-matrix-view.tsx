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
import { formatMoney, formatNumber } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import type { LeakageGroup } from "@/lib/data/insights";

/**
 * "Where it's leaking" — stockout %, dead-stock %, missed revenue and capital
 * tied up, rolled up by product category OR by ABC class, toggled in place.
 *
 * A client wrapper (mirroring top-earners-view.tsx) rather than two stacked
 * tables, because the toggle is view state a server component cannot hold. Both
 * cuts are handed over already-fetched, so flipping is instant and the export
 * always matches what is on screen.
 *
 * Capital tied up is a COST — the loader nulls it for a money-blind caller, and
 * this wrapper drops the whole column when `canViewCosts` is false, header and
 * cell together, so no masked placeholder is ever shown. Missed revenue is a
 * sales figure and stays for every role. Stockout% and dead-stock% turn red
 * whenever they are above zero — a leaking shelf should read as one.
 */

const LENSES = [
  { key: "category", label: "By category" },
  { key: "abc", label: "By ABC class" },
] as const;

type LensKey = (typeof LENSES)[number]["key"];

/** A percentage cell — red once it is above zero, a friendly dash when unmeasurable. */
function PctCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-ink-faint">—</span>;
  return <span className={pct > 0 ? "text-negative" : "text-ink"}>{pct}%</span>;
}

/** Export columns — the Capital column exists only for a cost viewer. */
const columns = (currency: string, canViewCosts: boolean): ExportColumn<LeakageGroup>[] => [
  { header: "Group", cell: (r) => r.group },
  { header: "SKUs", cell: (r) => r.skuCount },
  { header: "Stockout %", cell: (r) => (r.stockoutPct == null ? "" : r.stockoutPct) },
  { header: "Dead-stock %", cell: (r) => (r.deadStockPct == null ? "" : r.deadStockPct) },
  { header: `Missed (${currency})`, cell: (r) => r.missedRevenueKes },
  ...(canViewCosts
    ? [{ header: `Capital tied up (${currency})`, cell: (r: LeakageGroup) => r.capitalKes ?? "" }]
    : []),
];

export function LeakageMatrixView({
  byCategory,
  byAbc,
  windowDays,
  canViewCosts,
  currency,
}: {
  byCategory: LeakageGroup[];
  byAbc: LeakageGroup[];
  windowDays: number;
  canViewCosts: boolean;
  currency: string;
}) {
  const [lens, setLens] = useState<LensKey>("category");
  const ctxCurrency = useCurrency();

  const groups = lens === "category" ? byCategory : byAbc;
  const cols = useMemo(() => columns(ctxCurrency, canViewCosts), [ctxCurrency, canViewCosts]);

  if (byCategory.length === 0 && byAbc.length === 0) {
    return (
      <Card data-tour="insights-leakage-matrix">
        <CardHeader title="Where it's leaking" />
        <CardContent>
          <EmptyState
            title="Nothing to group yet"
            description="Once products are tracked and a full week of shelf history is in, the category and class breakdown appears here."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-tour="insights-leakage-matrix">
      <CardHeader
        title={`Where it's leaking · ${windowDays} days`}
        subtitle="Stockouts, dead stock and missed sales, grouped — worst first"
        action={
          groups.length > 0 ? (
            <ExportBar
              rows={groups}
              columns={cols}
              filename={`leakage-${lens}`}
              document={{
                title: "Where it's leaking",
                subtitle: `${lens === "category" ? "By category" : "By ABC class"} · ${windowDays} days`,
              }}
            />
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-1.5 px-4 pb-1">
        {LENSES.map((item) => {
          const on = lens === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setLens(item.key)}
              aria-pressed={on}
              className={cn(
                "inline-flex items-center rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors",
                on
                  ? "border-accent-200 bg-accent-soft text-accent-ink"
                  : "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="mt-1 pb-2">
        {groups.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">Nothing to group under this lens yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableHead>Group</TableHead>
              <TableHead numeric>SKUs</TableHead>
              <TableHead numeric>Stockout %</TableHead>
              <TableHead numeric>Dead-stock %</TableHead>
              <TableHead numeric>Missed</TableHead>
              {/* Capital is a cost — the whole column drops for a money-blind reader. */}
              {canViewCosts && <TableHead numeric>Capital tied up</TableHead>}
            </TableHeader>
            <TableBody>
              {groups.map((row) => (
                <TableRow key={row.group}>
                  <TableCell>
                    <span className="font-medium text-ink">{row.group}</span>
                  </TableCell>
                  <TableCell numeric>{formatNumber(row.skuCount)}</TableCell>
                  <TableCell numeric>
                    <PctCell pct={row.stockoutPct} />
                  </TableCell>
                  <TableCell numeric>
                    <PctCell pct={row.deadStockPct} />
                  </TableCell>
                  <TableCell numeric>{formatMoney(row.missedRevenueKes, currency)}</TableCell>
                  {canViewCosts && (
                    <TableCell numeric>
                      {row.capitalKes == null ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        formatMoney(row.capitalKes, currency)
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  );
}
