import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getTenantPlan } from "@/lib/capabilities";
import { PLAN_TIER_LABEL, planAllows, planFeatureTier } from "@/lib/capabilities/plan-features";

import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ABC_KEYS, abcLabel, parseAbcKey, type AbcKey } from "@/lib/data/abc-lens";
import {
  RANGE_KEYS,
  parseRangeKey,
  rangeDays,
  rangeShortLabel,
  rangeWeeks,
  type RangeKey,
} from "@/lib/data/report-range";
import { SkeletonCard, SkeletonTableRows } from "@/components/ui/skeleton";
import { parseReportTab, type ReportTab } from "./tabs";
import { ReportTabNav } from "./report-tab-nav";
import { ReportGuide } from "./report-guides";
import { OverviewTab } from "./overview-tab";
import { HistoryTab } from "./history-tab";
// Performance panels — kept inline (not the PerformanceTab wrapper) so the tab
// stays byte-identical to the prior "Is it working?" view, including DeadStockMonths
// and the class rail, which the thin wrapper deliberately omits. The exact-match
// Performance rebuild is a documented follow-up.
import { ForecastScorecard } from "./forecast-scorecard";
import { ImpactCard } from "./impact-card";
import { PeriodTable } from "./period-table";
import { DeadStockMonths } from "./dead-stock-months";
import { StockoutTrend } from "./stockout-trend";
import { BeforeAfter } from "./before-after";
import { MissedRevenueSection } from "./missed-revenue";
import { LeakageMatrixSection } from "./leakage-matrix";

export const metadata: Metadata = {
  title: "Reports",
};

const DESCRIPTION = "Where your money is stuck, and whether the forecast is earning its keep";

/**
 * The A/B/C lens for the Performance tab. (Overview has its own ClassFilter.)
 *
 * Rendered here rather than inside a panel because this is where the URL is
 * known, and it keeps what crosses into a panel a plain string. Passing an
 * href-builder down would break the moment a panel became a client component.
 */
function PerfClassRail({ abc, range }: { abc: AbcKey; range: RangeKey }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-ink-muted">Class</span>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by ABC class">
        {ABC_KEYS.map((key) => {
          const current = key === abc;
          return (
            <a
              key={key}
              href={`/insights?tab=performance&range=${range}&class=${key}`}
              aria-current={current ? "true" : undefined}
              className={
                current
                  ? "rounded-full bg-accent px-3 py-1 text-xs font-medium text-on-accent"
                  : "rounded-full border border-edge px-3 py-1 text-xs font-medium text-ink-muted hover:bg-surface-muted"
              }
            >
              {abcLabel(key)}
            </a>
          );
        })}
      </div>
    </div>
  );
}

/** The report period. Server-rendered links, not client state: a period is then
 *  shareable, survives a reload and works with Back. Present on both Overview
 *  (drives the revenue/top-earner windows) and Performance (drives the trend). */
function RangeRail({ tab, range }: { tab: ReportTab; range: RangeKey }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Report period">
        {RANGE_KEYS.map((key) => {
          const current = key === range;
          return (
            <a
              key={key}
              href={`/insights?tab=${tab}&range=${key}`}
              aria-current={current ? "true" : undefined}
              className={
                current
                  ? "rounded-full bg-accent px-3 py-1 text-xs font-medium text-on-accent"
                  : "rounded-full border border-edge px-3 py-1 text-xs font-medium text-ink-muted hover:bg-surface-muted"
              }
            >
              {rangeShortLabel(key)}
            </a>
          );
        })}
      </div>
      <p className="text-xs text-ink-muted">
        {tab === "performance"
          ? "Sets the trend and adherence windows. Accuracy grades whole elapsed horizons, and the impact card measures everything since your first order."
          : "Sets the top-earners and revenue windows. Shelf health is what’s on the shelf right now."}
      </p>
    </div>
  );
}

/**
 * The whole-shop report PDF — a session-guarded GET with no parameters that
 * drops cost figures for a money-blind member itself. A plain link, not a client
 * component.
 */
function ShopReportLink() {
  return (
    <a
      href="/api/reports/pdf"
      className="inline-flex h-9 items-center rounded-md border border-edge px-3 text-sm font-medium text-ink hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      Download shop report
    </a>
  );
}

/** Locked shell for a plan that doesn't include Insights. */
function InsightsLocked() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          title="Insights is on a higher plan"
          description="See where your shelves are empty, how much cash is sitting in stock that isn't moving, and whether the forecast has been telling you the truth."
          action={
            <p className="text-sm font-medium text-accent-ink">
              Included on the {PLAN_TIER_LABEL[planFeatureTier("insights")]} plan.
            </p>
          }
        />
      </CardContent>
    </Card>
  );
}

/** The Performance tab — the trend/proof panels. Kept inline (see import note). */
function PerformanceContent({
  tenantId,
  currency,
  canViewCosts,
  canRunCheck,
  range,
  abc,
}: {
  tenantId: string;
  currency: string;
  canViewCosts: boolean;
  canRunCheck: boolean;
  range: RangeKey;
  abc: AbcKey;
}) {
  return (
    <div className="space-y-6">
      <Suspense
        fallback={
          <div role="status" aria-label="Loading impact summary">
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <ImpactCard tenantId={tenantId} />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading before-and-after">
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <BeforeAfter tenantId={tenantId} />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading forecast scorecard">
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <ForecastScorecard tenantId={tenantId} canRunCheck={canRunCheck} windowDays={rangeDays(range)} />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading stockout trend">
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <StockoutTrend tenantId={tenantId} weeks={rangeWeeks(range)} />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading sales missed to empty shelves">
            <SkeletonCard lines={5} />
          </div>
        }
      >
        <MissedRevenueSection tenantId={tenantId} currency={currency} weeks={rangeWeeks(range)} abc={abc} />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading where it's leaking">
            <SkeletonTableRows rows={6} />
          </div>
        }
      >
        <LeakageMatrixSection
          tenantId={tenantId}
          currency={currency}
          weeks={rangeWeeks(range)}
          canViewCosts={canViewCosts}
        />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading dead stock by month">
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <DeadStockMonths tenantId={tenantId} canViewCosts={canViewCosts} />
      </Suspense>
      <PerfClassRail abc={abc} range={range} />
      <Suspense
        fallback={
          <div role="status" aria-label="Loading week-by-week metrics">
            <SkeletonTableRows rows={6} />
          </div>
        }
      >
        <PeriodTable tenantId={tenantId} weeks={rangeWeeks(range)} abc={abc} />
      </Suspense>
    </div>
  );
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view?: string; range?: string; class?: string }>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const params = await searchParams;
  const tab = parseReportTab(params);
  const range = parseRangeKey(typeof params.range === "string" ? params.range : null);
  const abc = parseAbcKey(typeof params.class === "string" ? params.class : null);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Account" title="Reports" description={DESCRIPTION} />
        <EmptyState
          title="No workspace yet"
          description="Create your shop's workspace to start, or ask an admin to invite you to theirs."
        />
      </div>
    );
  }

  const plan = await getTenantPlan(membership.tenantId);
  // Money-blind gate: MEMBERs (without view_costs) see no KES cost figures.
  const canViewCosts = hasPermission(membership, "view_costs");

  if (!planAllows(plan, "insights")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Account" title="Reports" description={DESCRIPTION} />
        <InsightsLocked />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account"
        title="Reports"
        description={DESCRIPTION}
        actions={<ShopReportLink />}
      />
      <ReportTabNav tab={tab} range={range} abc={abc} />

      <ReportGuide tab={tab} scope={membership.tenantId} />

      {tab !== "history" && <RangeRail tab={tab} range={range} />}

      {tab === "overview" && (
        <OverviewTab
          tenantId={membership.tenantId}
          currency={membership.tenant.currency}
          canViewCosts={canViewCosts}
          abc={abc}
          range={range}
          tab="overview"
        />
      )}

      {tab === "performance" && (
        <PerformanceContent
          tenantId={membership.tenantId}
          currency={membership.tenant.currency}
          canViewCosts={canViewCosts}
          canRunCheck={hasPermission(membership, "manage_settings")}
          range={range}
          abc={abc}
        />
      )}

      {tab === "history" && <HistoryTab tenantId={membership.tenantId} />}
    </div>
  );
}
