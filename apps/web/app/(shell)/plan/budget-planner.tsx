"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatCompact, formatMoney, formatNumber } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BudgetSplit, BuyListRow } from "@/lib/data/plan";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { planBudget } from "./actions";

/**
 * Mode 2 — the budget allocator. Enter the cash available; the engine funds
 * the list where it earns most and prices what deferring the rest will cost.
 */

const PRESETS = [400_000, 800_000, 1_500_000, 3_000_000];

const PLANNABLE_LABELS: Record<string, string> = {
  "missing-cost": "missing cost",
  "missing-price": "missing price",
  "cost-exceeds-price": "cost above price",
};

const dayLabel = (date: Date) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function BudgetPlanner({ canViewCosts }: { canViewCosts: boolean }) {
  const currency = useCurrency();
  const [budget, setBudget] = useState("800000");
  const [split, setSplit] = useState<BudgetSplit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function plan(budgetKes: number) {
    setError(null);
    startTransition(async () => {
      const result = await planBudget({ budgetKes });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSplit(result.data);
    });
  }

  const exportColumns: ExportColumn<BuyListRow & { status: string }>[] = [
    { header: "Status", cell: (r) => r.status },
    { header: "SKU", cell: (r) => r.sku },
    { header: "Product", cell: (r) => r.title },
    { header: "ABC", cell: (r) => r.abc ?? "" },
    { header: "Supplier", cell: (r) => r.supplierName ?? "" },
    { header: "MOQ", cell: (r) => r.moq },
    { header: "Lead days", cell: (r) => r.leadDays },
    { header: "Run/day", cell: (r) => r.runRatePerDay },
    { header: "Days left", cell: (r) => r.daysUntilStockout },
    { header: "Order by", cell: (r) => dayLabel(r.orderByDate) },
    { header: "Order qty", cell: (r) => r.recommendedQty },
    // Revenue is a sales figure — exported for every role.
    { header: `Revenue 30d (${currency})`, cell: (r) => r.revenue30dKes },
    // Money-blind members export what they see: no cost columns.
    ...(canViewCosts
      ? ([
          { header: `Line total (${currency})`, cell: (r) => r.lineTotalKes },
          { header: `At risk 30d (${currency})`, cell: (r) => r.atRiskKes },
        ] satisfies ExportColumn<BuyListRow & { status: string }>[])
      : []),
  ];

  const exportRows = split
    ? [
        ...split.funded.map((r) => ({ ...r, status: "Buy now" })),
        ...split.deferred.map((r) => ({ ...r, status: "Deferred" })),
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">
          Spend where it earns most — deferrals come with their price.
        </p>
        {split && (
          <ExportBar
            rows={exportRows}
            columns={exportColumns}
            filename="budget-plan"
            document={{
              title: "Restock budget plan",
              subtitle: canViewCosts
                ? `Budget ${formatMoney(split.budgetKes, currency)} · ${split.funded.length} funded, ${split.deferred.length} deferred`
                : `${split.funded.length} funded, ${split.deferred.length} deferred`,
            }}
          />
        )}
      </div>

      <Card>
        <CardContent className="space-y-3">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              plan(Number(budget) || 0);
            }}
          >
            <label htmlFor="budget-kes" className="text-sm text-ink-muted">
              Budget ({currency})
            </label>
            <Input
              id="budget-kes"
              inputMode="numeric"
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ""))}
              className="w-36 font-mono"
            />
            {PRESETS.map((preset) => (
              <Button
                key={preset}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setBudget(String(preset))}
              >
                {formatCompact(preset)}
              </Button>
            ))}
            <Button type="submit" size="sm" loading={pending}>
              Plan my restock
            </Button>
          </form>
          {error && <p className="text-sm text-negative">{error}</p>}
        </CardContent>
      </Card>

      {split && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Funded now"
              value={String(split.funded.length)}
              delta={{
                label: canViewCosts
                  ? `${formatMoney(split.fundedCostKes ?? 0, currency, { compact: true })} of the budget`
                  : "items bought within budget",
                tone: "neutral",
              }}
            />
            <StatTile
              label="Deferred"
              value={String(split.deferred.length)}
              delta={{
                label: canViewCosts
                  ? `${formatMoney(split.deferredCostKes ?? 0, currency, { compact: true })} to fund fully`
                  : "items held for later",
                tone: "neutral",
              }}
            />
            <StatTile
              label="Revenue at risk"
              value={<CostValue amount={split.deferredAtRiskKes} canViewCosts={canViewCosts} compact />}
              delta={{ label: "next 30 days, if deferrals stock out", tone: "neutral" }}
            />
            <StatTile
              label={(split.overBudgetKes ?? 0) > 0 ? "Over budget" : "Left over"}
              value={
                <CostValue
                  amount={(split.overBudgetKes ?? 0) > 0 ? split.overBudgetKes : split.leftoverKes}
                  canViewCosts={canViewCosts}
                  compact
                />
              }
              delta={
                (split.overBudgetKes ?? 0) > 0
                  ? { label: "criticals don't wait for budget", tone: "negative" }
                  : { label: "unspent after funding", tone: "positive" }
              }
            />
          </div>

          <Card>
            <CardHeader
              title={`Buy now · ${split.funded.length}`}
              subtitle="Funded within the budget, highest earners first."
            />
            <div className="mt-2 pb-2">
              {split.funded.length === 0 ? (
                <CardContent>
                  <p className="text-sm text-ink-muted">
                    The budget doesn&apos;t reach anything — raise it or clear a critical first.
                  </p>
                </CardContent>
              ) : (
                <BudgetTable rows={split.funded} canViewCosts={canViewCosts} />
              )}
            </div>
          </Card>

          {split.deferred.length > 0 && (
            <Card>
              <CardHeader
                title={`Deferred · ${split.deferred.length}`}
                subtitle="What waiting costs: sales the forecast expects each item to miss while it sits stocked out over the next 30 days."
              />
              <div className="mt-2 pb-2">
                <BudgetTable rows={split.deferred} canViewCosts={canViewCosts} showAtRisk />
              </div>
            </Card>
          )}

          {split.checkCost.length > 0 && (
            <Card>
              <CardHeader
                title={`Check these costs · ${split.checkCost.length}`}
                subtitle="Missing or broken cost data — the allocator can't budget them until the numbers are fixed."
              />
              <CardContent className="pt-3">
                <ul className="space-y-2 text-sm">
                  {split.checkCost.map((row) => (
                    <li key={row.predictionId} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{row.title}</span>
                      <span className="font-mono text-xs text-ink-muted">{row.sku}</span>
                      <Badge tone="warning">{PLANNABLE_LABELS[row.plannable] ?? row.plannable}</Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function BudgetTable({
  rows,
  canViewCosts,
  showAtRisk = false,
}: {
  rows: BuyListRow[];
  canViewCosts: boolean;
  showAtRisk?: boolean;
}) {
  const currency = useCurrency();
  return (
    <Table>
      <TableHeader>
        <TableHead>Product</TableHead>
        <TableHead className="hidden md:table-cell">Supplier</TableHead>
        <TableHead numeric className="hidden md:table-cell">Run/day</TableHead>
        <TableHead numeric>Days left</TableHead>
        <TableHead className="hidden md:table-cell">Order by</TableHead>
        <TableHead numeric>Qty</TableHead>
        <TableHead numeric className="hidden lg:table-cell">Rev · 30d ({currency})</TableHead>
        <TableHead numeric>Line total</TableHead>
        {showAtRisk && <TableHead numeric>At risk (30d)</TableHead>}
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const overdue = row.daysLeftToOrder <= 0;
          return (
            <TableRow key={row.predictionId}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{row.title}</span>
                  {row.abc && <Badge tone="neutral">{row.abc}</Badge>}
                </div>
                <div className="mt-0.5 font-mono text-xs text-ink-muted">{row.sku}</div>
              </TableCell>
              <TableCell className="hidden md:table-cell">{row.supplierName ?? "—"}</TableCell>
              <TableCell numeric className="hidden md:table-cell">{row.runRatePerDay}</TableCell>
              <TableCell numeric>
                {row.onHandUnits <= 0 || row.daysUntilStockout == null
                  ? "—"
                  : `${row.daysUntilStockout}d`}
              </TableCell>
              <TableCell className="hidden md:table-cell">
                {overdue ? (
                  <span className="font-medium text-negative">{dayLabel(row.orderByDate)}</span>
                ) : (
                  dayLabel(row.orderByDate)
                )}
              </TableCell>
              <TableCell numeric>{row.recommendedQty}</TableCell>
              <TableCell numeric className="hidden lg:table-cell">
                {/* Revenue is a sales figure — visible to every role as a plain
                    amount whose unit lives in the header. */}
                {row.revenue30dKes > 0 ? formatNumber(row.revenue30dKes) : "—"}
              </TableCell>
              <TableCell numeric>
                <CostValue amount={row.lineTotalKes} canViewCosts={canViewCosts} />
              </TableCell>
              {showAtRisk && (
                <TableCell numeric>
                  {(row.atRiskKes ?? 0) > 0 ? (
                    <CostValue amount={row.atRiskKes} canViewCosts={canViewCosts} className="text-negative" />
                  ) : (
                    "—"
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
