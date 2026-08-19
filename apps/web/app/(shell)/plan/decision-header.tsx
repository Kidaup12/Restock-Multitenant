"use client";

import { CostValue } from "@/components/ui/cost-value";
import type { BuyListRow, BuyTier } from "@/lib/data/plan";

/**
 * Decision header for the buy checklist: what has to be ordered today, and what
 * the rest of the list can wait for. The headline is WHEN money must move, not
 * one undifferentiated total — the three tiers already sort the list that way,
 * so the header just totals them.
 *
 * Every figure is summed from the rows the checklist already has, so the header
 * always reflects the scope on screen and needs no extra data fetch. Cost sums
 * stay money-blind: they're built from fields the data layer already nulls for a
 * member, so a null propagates through the total and CostValue masks it.
 */

/** One tier's roll-up. Cash is null when any row in it has its cost hidden. */
export type TierTotal = { count: number; cashKes: number | null };

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
  /** Count and cash per tier, so the header can say when each pile is due. */
  tiers: Record<BuyTier, TierTotal>;
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

function tierTotal(rows: BuyListRow[], tier: BuyTier): TierTotal {
  const inTier = rows.filter((r) => r.tier === tier);
  return { count: inTier.length, cashKes: sumOrNull(inTier.map((r) => r.lineTotalKes)) };
}

/** Pure: the header's figures from the buy-list rows in view. */
export function planDecisionSummary(rows: BuyListRow[]): PlanDecisionSummary {
  return {
    orderTodayCount: rows.filter((r) => r.tier === "order_today").length,
    criticalsCashKes: sumOrNull(
      rows.filter((r) => r.urgency === "critical").map((r) => r.lineTotalKes)
    ),
    atRiskKes: sumOrNull(rows.map((r) => r.atRiskKes)),
    productCount: rows.length,
    tiers: {
      order_today: tierTotal(rows, "order_today"),
      this_week: tierTotal(rows, "this_week"),
      can_wait: tierTotal(rows, "can_wait"),
    },
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

  const { order_today: today, this_week: thisWeek, can_wait: canWait } = summary.tiers;
  const urgent = today.count > 0;

  return (
    <div className="rounded-lg border border-edge bg-surface p-5 shadow-card">
      <div className="text-2xs tracking-wider text-ink-muted uppercase">Order today</div>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The headline is the cash that has to move now. A money-blind member
            gets the count instead — a masked figure makes a poor headline, and
            the count is the part of the answer they are allowed to have. */}
        <span
          className={`font-mono text-3xl font-semibold tracking-tight ${
            urgent ? "text-accent-ink" : "text-positive"
          }`}
        >
          {!urgent ? (
            "None"
          ) : canViewCosts ? (
            <CostValue amount={today.cashKes} canViewCosts={canViewCosts} compact />
          ) : (
            today.count
          )}
        </span>
        <span className="text-sm text-ink-muted">
          {urgent
            ? `${today.count} ${today.count === 1 ? "item is" : "items are"} past the last safe day — order now or they run out before the delivery lands.`
            : "Nothing is overdue. The rest of the list can be ordered on its own schedule."}
        </span>
      </div>

      <div className="mt-2.5 text-sm text-ink-muted">
        This week — <CostValue amount={thisWeek.cashKes} canViewCosts={canViewCosts} compact /> (
        {thisWeek.count}) · Can wait —{" "}
        <CostValue amount={canWait.cashKes} canViewCosts={canViewCosts} compact /> ({canWait.count})
        <span className="ml-2 text-2xs">each line shows its order-by date</span>
      </div>

      <div className="mt-1 text-sm text-ink-muted">
        Cash for criticals —{" "}
        <CostValue amount={summary.criticalsCashKes} canViewCosts={canViewCosts} compact /> ·
        Revenue at risk if you wait —{" "}
        <CostValue amount={summary.atRiskKes} canViewCosts={canViewCosts} compact />
      </div>
    </div>
  );
}
