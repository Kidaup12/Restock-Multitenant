"use client";

import { CostValue } from "@/components/ui/cost-value";
import { StatTile } from "@/components/ui/stat-tile";
import type { BuyListRow } from "@/lib/data/plan";

/**
 * Decision header for the buy checklist: the four numbers that answer "what do I
 * do about this list right now" — how many items can't wait, the cash it takes
 * to order the ones at real risk, the sales on the line if you defer, and how
 * much of the plan you're looking at. Every figure is summed from the rows the
 * checklist already has, so the header always reflects the scope on screen and
 * needs no extra data fetch. Cost sums stay money-blind: they're built from
 * fields the data layer already nulls for a member, so a null propagates through
 * the total and CostValue masks it.
 */

export type PlanDecisionSummary = {
  /** Rows tiered "order today" — critical, or already past their safe order day. */
  orderTodayCount: number;
  /** Cost to order every urgency-critical line. Null when any critical row's cost
   *  is hidden (a money-blind member) — an unknown sum stays unknown, not zero. */
  criticalsCashKes: number | null;
  /** Sales the forecast expects to miss over 30 days if the whole list waits.
   *  Null when any row's at-risk figure is hidden. */
  atRiskKes: number | null;
  /** How many products the current (scoped) list covers. */
  productCount: number;
};

/** Sum that propagates the unknown: a single null makes the whole total null
 *  rather than silently dropping to a smaller, wrong number. An empty list sums
 *  to 0 — nothing unknown about having nothing to add. */
function sumOrNull(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value == null) return null;
    total += value;
  }
  return total;
}

/** Pure: the header's four figures from the buy-list rows in view. */
export function planDecisionSummary(rows: BuyListRow[]): PlanDecisionSummary {
  return {
    orderTodayCount: rows.filter((r) => r.tier === "order_today").length,
    criticalsCashKes: sumOrNull(
      rows.filter((r) => r.urgency === "critical").map((r) => r.lineTotalKes)
    ),
    atRiskKes: sumOrNull(rows.map((r) => r.atRiskKes)),
    productCount: rows.length,
  };
}

export function PlanDecisionHeader({
  rows,
  canViewCosts,
}: {
  rows: BuyListRow[];
  canViewCosts: boolean;
}) {
  const summary = planDecisionSummary(rows);
  // Nothing on the list (an empty scope) — the checklist shows its own empty
  // state; a row of zeroes above it would only add noise.
  if (summary.productCount === 0) return null;

  const urgent = summary.orderTodayCount > 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label="Order today"
        value={String(summary.orderTodayCount)}
        delta={{
          label: urgent ? "can't wait — order now" : "nothing overdue",
          tone: urgent ? "negative" : "positive",
        }}
      />
      <StatTile
        label="Cash for criticals"
        value={<CostValue amount={summary.criticalsCashKes} canViewCosts={canViewCosts} compact />}
        delta={{ label: "to order every must-have now", tone: "neutral" }}
      />
      <StatTile
        label="Revenue at risk"
        value={<CostValue amount={summary.atRiskKes} canViewCosts={canViewCosts} compact />}
        delta={{ label: "sales at stake in 30 days if you wait", tone: "negative" }}
      />
      <StatTile
        label="Products to restock"
        value={String(summary.productCount)}
        delta={{ label: "on this list", tone: "neutral" }}
      />
    </div>
  );
}
