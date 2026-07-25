"use client";

import { useState } from "react";
import { BanknoteIcon, CalendarIcon, ClipboardIcon } from "@/components/icons";
import { PLAN_TIER_LABEL, planFeatureTier } from "@/lib/capabilities/plan-features";
import type { BuyList } from "@/lib/data/plan";
import { BudgetPlanner } from "./budget-planner";
import { BuyChecklist } from "./buy-checklist";
import { EMPTY_SCOPE, filterBuyListRows, ScopeBar, type ScopeSelection } from "./scope-bar";
import { SupplyCalendarMode } from "./supply-calendar";

/**
 * The planner's ways in: the full tiered checklist ("show me what to order, and
 * why"), the budget allocator ("I have a budget to keep"), or the forward
 * supply calendar ("what's coming up, and when"). Nothing is planned until the
 * user picks.
 */

type Mode = "choose" | "list" | "budget" | "calendar";

function ModeCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-edge bg-surface p-5 text-left shadow-card transition-colors hover:border-edge-strong hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <div className="grid size-9 place-items-center rounded-md bg-accent-soft text-accent-ink [&_svg]:size-4.5">
        {icon}
      </div>
      <h2 className="mt-3 font-display text-base font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-ink-muted">{description}</p>
    </button>
  );
}

/** A mode the tenant's plan doesn't include yet: shown, but locked, with a
 *  one-line upsell instead of an action. */
function LockedModeCard({
  icon,
  title,
  description,
  upsell,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  upsell: string;
}) {
  return (
    <div
      aria-disabled="true"
      className="rounded-lg border border-edge bg-surface p-5 text-left opacity-75"
    >
      <div className="grid size-9 place-items-center rounded-md bg-surface-2 text-ink-muted [&_svg]:size-4.5">
        {icon}
      </div>
      <h2 className="mt-3 font-display text-base font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-ink-muted">{description}</p>
      <p className="mt-3 text-sm font-medium text-accent-ink">{upsell}</p>
    </div>
  );
}

export function PlanView({
  buyList,
  canViewCosts,
  canBudget,
  canOverride,
}: {
  buyList: BuyList;
  canViewCosts: boolean;
  canBudget: boolean;
  canOverride: boolean;
}) {
  const [mode, setMode] = useState<Mode>("choose");
  const [scope, setScope] = useState<ScopeSelection>(EMPTY_SCOPE);
  const budgetTier = PLAN_TIER_LABEL[planFeatureTier("budget_planner")];

  if (mode === "choose") {
    const runDay = new Date(buyList.runDate).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {buyList.rows.length} of {buyList.totalPredicted} forecast products need restocking ·
          run {runDay}. Nothing is planned until you pick.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ModeCard
            icon={<ClipboardIcon />}
            title="Show me what to order, and why"
            description="Every product that needs restocking, tiered by its last safe day to order. Each quantity comes with its arithmetic. You tick, we total."
            onClick={() => setMode("list")}
          />
          <ModeCard
            icon={<CalendarIcon />}
            title="See my ordering calendar"
            description="The next three months of order-by dates, grouped by supplier, with the cash each month needs — your upcoming ordering commitments at a glance."
            onClick={() => setMode("calendar")}
          />
          {canBudget ? (
            <ModeCard
              icon={<BanknoteIcon />}
              title="I have a budget to keep"
              description="Tell us the cash you can spend. We put it where it earns most, and show you, in shillings and days, what the items you defer will cost."
              onClick={() => setMode("budget")}
            />
          ) : (
            <LockedModeCard
              icon={<BanknoteIcon />}
              title="I have a budget to keep"
              description="Tell us the cash you can spend. We put it where it earns most, and show you, in shillings and days, what the items you defer will cost."
              upsell={`Budget planner is on the ${budgetTier} plan.`}
            />
          )}
        </div>
      </div>
    );
  }

  const backLink = (
    <button
      type="button"
      onClick={() => setMode("choose")}
      className="text-sm font-medium text-accent-ink hover:underline"
    >
      Start over
    </button>
  );

  if (mode === "list") {
    // Scope the list before the checklist sees it: it renders whatever buyList
    // it's given, so the filtered rows keep its "N products" line honest. The
    // total re-sums the visible rows (null stays null for a money-blind member).
    const filteredRows = filterBuyListRows(buyList.rows, scope);
    const filteredBuyList: BuyList = {
      ...buyList,
      rows: filteredRows,
      totalCostKes: canViewCosts
        ? filteredRows.reduce((sum, r) => sum + (r.lineTotalKes ?? 0), 0)
        : null,
    };
    return (
      <div className="space-y-4">
        <ScopeBar
          rows={buyList.rows}
          selection={scope}
          onChange={setScope}
          showing={filteredRows.length}
        />
        <BuyChecklist
          buyList={filteredBuyList}
          canViewCosts={canViewCosts}
          canOverride={canOverride}
          backLink={backLink}
        />
      </div>
    );
  }
  if (mode === "calendar") {
    return <SupplyCalendarMode canViewCosts={canViewCosts} backLink={backLink} />;
  }
  return <BudgetPlanner canViewCosts={canViewCosts} backLink={backLink} />;
}
