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
import {
  COVER_MAX,
  COVER_MIN,
  COVER_STEP,
  DEFAULT_BUDGET_COVER_DAYS,
  clampCoverDays,
} from "./cover";
import { Stepper } from "@/components/ui/stepper";
import { LeadFlooredNote } from "./lead-floored-note";

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

  // The cover target starts on: "spend this much" is only half a question
  // without "to last how long". Unticking it returns to the plan's own horizon,
  // which is what this screen allocated against before the target existed.
  const [coverDays, setCoverDays] = useState<number | null>(DEFAULT_BUDGET_COVER_DAYS);

  // The budget caps unless the shop says otherwise. Off means a must-restock
  // line that does not fit is deferred and counted, rather than quietly pushing
  // the plan past the cash the shop actually has.
  const [allowOverflow, setAllowOverflow] = useState(false);

  function plan(budgetKes: number, cover: number | null, overflow = allowOverflow) {
    setError(null);
    startTransition(async () => {
      const result = await planBudget({ budgetKes, coverDays: cover, allowOverflow: overflow });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSplit(result.data);
    });
  }

  /** Change the horizon. Re-plans straight away once there is a split on screen,
   *  so the effect of the change is visible where it lands. */
  function applyCover(cover: number | null) {
    setCoverDays(cover);
    if (split) plan(Number(budget) || 0, cover);
  }

  /** Flipping the cap re-plans immediately: the toggle changes the answer, so
   *  leaving the old split on screen beside the new setting would misreport it. */
  function applyOverflow(next: boolean) {
    setAllowOverflow(next);
    if (split) plan(Number(budget) || 0, coverDays, next);
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
              plan(Number(budget) || 0, coverDays);
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

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-edge bg-surface-2/40 px-4 py-3">
            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={coverDays != null}
                onChange={(e) => applyCover(e.target.checked ? DEFAULT_BUDGET_COVER_DAYS : null)}
                className="size-4 rounded border-edge accent-accent"
              />
              Stock to a cover target
            </label>
            {coverDays != null && (
              <Stepper
                label="Days of cover"
                value={`${coverDays} days`}
                onDecrement={() => applyCover(clampCoverDays(coverDays - COVER_STEP))}
                onIncrement={() => applyCover(clampCoverDays(coverDays + COVER_STEP))}
                decrementLabel="Fewer days of cover"
                incrementLabel="More days of cover"
                canDecrement={coverDays > COVER_MIN}
                canIncrement={coverDays < COVER_MAX}
                busy={pending}
                edit={{
                  value: coverDays,
                  min: COVER_MIN,
                  max: COVER_MAX,
                  unit: "days",
                  ariaLabel: "Days of cover",
                  onCommit: (next) => applyCover(clampCoverDays(next)),
                }}
              />
            )}
            <p className="max-w-prose text-xs text-ink-muted">
              {coverDays == null
                ? "Off: the budget is spread over the plan's own horizon, the quantities the nightly run recommends."
                : `Every line is sized to ${coverDays} days of cover first — never below an item's lead time — and the budget is then spread over that list. Answers "spend this cash, but stock to this long".`}
            </p>

            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={allowOverflow}
                onChange={(e) => applyOverflow(e.target.checked)}
                className="size-4 rounded border-edge accent-accent"
              />
              Let criticals exceed budget
            </label>
            <p className="max-w-prose text-xs text-ink-muted">
              {allowOverflow
                ? "On: must-restock lines are funded whatever they cost, and the plan reports how far past the budget that puts you."
                : "Off: the budget is a cap. Must-restock lines are funded first, and any that still don't fit are held back and counted rather than quietly spending money you haven't got."}
            </p>
          </div>

          {error && <p className="text-sm text-negative">{error}</p>}
        </CardContent>
      </Card>

      {split && (
        <>
          {split.deferredCriticalCount > 0 && (
            <div className="rounded-lg border border-warning bg-warning-soft p-3 text-sm text-warning">
              <span className="font-medium">
                {split.deferredCriticalCount} must-restock{" "}
                {split.deferredCriticalCount === 1 ? "line doesn't" : "lines don't"} fit this budget
              </span>{" "}
              — <CostValue amount={split.deferredCriticalKes} canViewCosts={canViewCosts} />{" "}
              more would cover them. They&apos;re held back below: raise the budget, or accept the
              stockout risk.
            </div>
          )}

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
                  {/* Two different situations, and only one of them is about the
                      budget. Telling an owner to raise an untouched KES 800K
                      because nothing was waiting to be ordered points them away
                      from the real cause — a buy list held back for missing
                      costs, products too new, or stock already on order. */}
                  {split.incomingCount === 0 ? (
                    <p className="text-sm text-ink-muted">
                      Nothing is waiting to be ordered, so there is nothing for this budget to
                      fund.
                      {split.heldBackCount > 0 && (
                        <>
                          {" "}
                          {split.heldBackCount}{" "}
                          {split.heldBackCount === 1 ? "product is" : "products are"} held back —
                          open the buy list to see why.
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="text-sm text-ink-muted">
                      The budget doesn&apos;t reach anything — raise it or clear a critical first.
                    </p>
                  )}
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
                <BudgetTable rows={split.deferred} canViewCosts={canViewCosts} />
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

export function BudgetTable({
  rows,
  canViewCosts,
}: {
  rows: BuyListRow[];
  canViewCosts: boolean;
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
        <TableHead numeric>At risk (30d)</TableHead>
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
              <TableCell numeric>
                {row.recommendedQty}
                {row.leadFloored && <LeadFlooredNote leadDays={row.leadDays} />}
              </TableCell>
              <TableCell numeric className="hidden lg:table-cell">
                {/* Revenue is a sales figure — visible to every role as a plain
                    amount whose unit lives in the header. */}
                {row.revenue30dKes > 0 ? formatNumber(row.revenue30dKes) : "—"}
              </TableCell>
              <TableCell numeric>
                <CostValue amount={row.lineTotalKes} canViewCosts={canViewCosts} />
              </TableCell>
              <TableCell numeric>
                {(row.atRiskKes ?? 0) > 0 ? (
                  <CostValue amount={row.atRiskKes} canViewCosts={canViewCosts} className="text-negative" />
                ) : (
                  "—"
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
