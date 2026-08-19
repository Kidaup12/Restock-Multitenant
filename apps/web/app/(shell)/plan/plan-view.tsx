"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BanknoteIcon, CalendarIcon, ClipboardIcon } from "@/components/icons";
import { PLAN_TIER_LABEL, planFeatureTier } from "@/lib/capabilities/plan-features";
import type { PlanFreshness as Freshness } from "@/lib/data/forecast-freshness";
import type { BuyList } from "@/lib/data/plan";
import { BudgetPlanner } from "./budget-planner";
import { BuyChecklist } from "./buy-checklist";
import { PlanDecisionHeader } from "./decision-header";
import { PlanFreshness } from "./plan-freshness";
import { PreflightStrip } from "./preflight-strip";
import { deleteScope, listScopes, saveScope, type SavedScope } from "./scope-actions";
import { EMPTY_SCOPE, filterBuyListRows, ScopeBar, type ScopeSelection } from "./scope-bar";
import { SupplyCalendarMode } from "./supply-calendar";

/**
 * The planner's ways in: the full tiered checklist ("show me what to order, and
 * why"), the budget allocator ("I have a budget to keep"), or the forward
 * supply calendar ("what's coming up, and when"). Nothing is planned until the
 * user picks.
 */

type Mode = "choose" | "list" | "budget" | "calendar";

const MODES: readonly Mode[] = ["choose", "list", "budget", "calendar"];

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
      <h2 className="mt-3 text-base font-semibold text-ink">{title}</h2>
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
      <h2 className="mt-3 text-base font-semibold text-ink">{title}</h2>
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
  freshness: planFreshness,
}: {
  buyList: BuyList;
  canViewCosts: boolean;
  canBudget: boolean;
  canOverride: boolean;
  /** Decided server-side, so the verdict cannot drift between render and hydration. */
  freshness: Freshness;
}) {
  // The mode lives in the URL, not in component state. It used to be state
  // alone, which meant Back left the planner entirely instead of returning to
  // the cards, and a mode could be neither linked nor reloaded into.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get("mode") as Mode | null;
  const mode: Mode =
    requested && MODES.includes(requested) && !(requested === "budget" && !canBudget)
      ? requested
      : "choose";

  const setMode = useCallback(
    (next: Mode) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "choose") params.delete("mode");
      else params.set("mode", next);
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const [scope, setScope] = useState<ScopeSelection>(EMPTY_SCOPE);
  const [savedScopes, setSavedScopes] = useState<SavedScope[]>([]);
  const [scopesBusy, startScopes] = useTransition();
  const budgetTier = PLAN_TIER_LABEL[planFeatureTier("budget_planner")];

  // Load the member's saved scopes once — the tenant/user resolve server-side in
  // the action, so nothing tenant-identifying rides the client request.
  useEffect(() => {
    let active = true;
    listScopes().then((res) => {
      if (active && res.ok) setSavedScopes(res.data);
    });
    return () => {
      active = false;
    };
  }, []);

  function handleSaveScope(name: string) {
    startScopes(async () => {
      const res = await saveScope({ name, selection: scope });
      if (res.ok) setSavedScopes((prev) => [...prev, res.data]);
    });
  }

  function handleDeleteScope(id: string) {
    startScopes(async () => {
      const res = await deleteScope({ id });
      if (res.ok) setSavedScopes((prev) => prev.filter((s) => s.id !== id));
    });
  }

  // One authority for how old the plan is, shown in every mode — it used to
  // appear only here, as grey text, and vanish the moment a mode was picked.
  const freshness = <PlanFreshness freshness={planFreshness} />;

  if (mode === "choose") {
    return (
      <div className="space-y-4">
        {freshness}
        <p className="text-sm text-ink-muted">
          {buyList.rows.length} of {buyList.totalPredicted} forecast products need restocking.
          Nothing is planned until you pick.
          {buyList.excluded.length > 0 && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => setMode("list")}
                className="font-medium text-accent-ink hover:underline"
              >
                {`${buyList.excluded.length} aren’t on the list — see why`}
              </button>
            </>
          )}
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
              description="Tell us the cash you can spend. We put it where it earns most, and show you, in money and days, what the items you defer will cost."
              onClick={() => setMode("budget")}
            />
          ) : (
            <LockedModeCard
              icon={<BanknoteIcon />}
              title="I have a budget to keep"
              description="Tell us the cash you can spend. We put it where it earns most, and show you, in money and days, what the items you defer will cost."
              upsell={`Budget planner is on the ${budgetTier} plan.`}
            />
          )}
        </div>
      </div>
    );
  }

  // A way out of every mode, at the top where navigation belongs. It used to be
  // the tail of a grey summary sentence, which reads as prose rather than a way
  // back. "Plan options" and not "Plan": the user never left /plan.
  const backToOptions = (
    <button
      type="button"
      onClick={() => setMode("choose")}
      className="text-sm font-medium text-accent-ink hover:underline"
    >
      ← All plan options
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
      // The not-on-the-list section is scoped by the same selection: it is now
      // most of the catalogue, so leaving it unfiltered would have the scope bar
      // narrow the top of the page and not the bottom.
      excluded: filterBuyListRows(buyList.excluded, scope) as typeof buyList.excluded,
      totalCostKes: canViewCosts
        ? filteredRows.reduce((sum, r) => sum + (r.lineTotalKes ?? 0), 0)
        : null,
    };
    return (
      <div className="space-y-4">
        {backToOptions}
        {freshness}
        {/* Scanned over the WHOLE plan, not the scoped rows: a data problem that
            disappears when you narrow the list is one you order straight past. */}
        <PreflightStrip rows={buyList.rows} />
        <PlanDecisionHeader rows={filteredRows} canViewCosts={canViewCosts} />
        <ScopeBar
          rows={buyList.rows}
          selection={scope}
          onChange={setScope}
          showing={filteredRows.length}
          savedScopes={savedScopes}
          onSaveScope={handleSaveScope}
          onDeleteScope={handleDeleteScope}
          scopesBusy={scopesBusy}
        />
        <BuyChecklist
          buyList={filteredBuyList}
          canViewCosts={canViewCosts}
          canOverride={canOverride}
        />
      </div>
    );
  }
  if (mode === "calendar") {
    return (
      <div className="space-y-4">
        {backToOptions}
        {freshness}
        <SupplyCalendarMode canViewCosts={canViewCosts} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {backToOptions}
      {freshness}
      <BudgetPlanner canViewCosts={canViewCosts} />
    </div>
  );
}
