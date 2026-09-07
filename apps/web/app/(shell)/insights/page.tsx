import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getTenantPlan } from "@/lib/capabilities";
import { PLAN_TIER_LABEL, planAllows, planFeatureTier } from "@/lib/capabilities/plan-features";

import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedNav } from "@/components/ui/segmented-nav";
import { PageHeader } from "@/components/ui/page-header";
import {
  RANGE_KEYS,
  parseRangeKey,
  rangeDays,
  rangeShortLabel,
  rangeWeeks,
  type RangeKey,
} from "@/lib/data/report-range";
import { SkeletonCard, SkeletonStatTile, SkeletonTableRows } from "@/components/ui/skeleton";
import { ForecastScorecard } from "./forecast-scorecard";
import { ImpactCard } from "./impact-card";
import { ShelfHealth } from "./shelf-health";
import { StockoutTrend } from "./stockout-trend";
import { TopEarners } from "./top-earners";

export const metadata: Metadata = {
  title: "Reports",
};

const DESCRIPTION = "Where your money is stuck, and whether the forecast is earning its keep";

/**
 * The period the report covers.
 *
 * Server-rendered links, not client state: a period is then shareable, survives
 * a reload and works with Back, the same way the view tabs already do.
 *
 * It says what it does NOT drive, deliberately. Shelf health and the impact
 * card are snapshots — what is empty right now, and everything since the first
 * order — so a period control silently sitting above them would be read as
 * changing numbers it cannot change. That is the "control far from its effect"
 * defect this codebase has already produced three times.
 */
function RangeRail({ range, view }: { range: RangeKey; view: "now" | "proof" }) {
  const base = view === "proof" ? "/insights?view=proof" : "/insights?";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Report period">
        {RANGE_KEYS.map((key) => {
          const current = key === range;
          return (
            <a
              key={key}
              href={`${base}${view === "proof" ? "&" : ""}range=${key}`}
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
      <p className="text-xs text-ink-faint">
        {view === "proof"
          ? "Sets the trend window. The impact card measures everything since your first order."
          : "Sets the top-earners window. Shelf health is what’s on the shelf right now."}
      </p>
    </div>
  );
}

/**
 * The whole-shop report — revenue, capital tied up, ABC mix, dead stock,
 * stockouts and top movers on one page.
 *
 * It was built, routed and rendered, and nothing anywhere linked to it: the only
 * mention of /api/reports/pdf in the tree was its own renderer's comment. A
 * report nobody can reach is not a feature, and this is the fourth time in this
 * codebase that something complete has sat unreachable.
 *
 * A plain link, not a client component: the route is a session-guarded GET with
 * no parameters, and it drops cost figures for a money-blind member itself.
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

function ViewTabs({ view }: { view: "now" | "proof" }) {
  return (
    <SegmentedNav
      label="Report views"
      data-tour="insights-tabs"
      items={[
        { href: "/insights", label: "Where you stand", active: view === "now" },
        { href: "/insights?view=proof", label: "Is it working?", active: view === "proof" },
      ]}
    />
  );
}

/** Locked shell for a plan that doesn't include Insights — name what it holds so
 *  the owner can see what upgrading buys rather than an empty page. */
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

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; range?: string }>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const params = await searchParams;
  const view = params.view === "proof" ? "proof" : "now";
  const range = parseRangeKey(typeof params.range === "string" ? params.range : null);

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
      <ViewTabs view={view} />
      <RangeRail range={range} view={view} />

      {view === "now" ? (
        <Suspense
          fallback={
            <div className="space-y-6" role="status" aria-label="Loading shelf health">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <SkeletonStatTile />
                <SkeletonStatTile />
                <SkeletonStatTile />
              </div>
              {/* Shelf health loads TWO tables — empty shelves, then dead
                  stock. One stood in for both and the page jumped on load. */}
              <SkeletonTableRows rows={6} />
              <SkeletonTableRows rows={6} />
            </div>
          }
        >
          <ShelfHealth
            tenantId={membership.tenantId}
            canViewCosts={canViewCosts}
            currency={membership.tenant.currency}
          />
        </Suspense>
      ) : null}

      {view === "now" && (
        <Suspense
          fallback={
            <div role="status" aria-label="Loading top earners">
              <SkeletonTableRows rows={8} />
            </div>
          }
        >
          {/* The report's headline: which products actually bring the money in,
              filterable by ABC class. */}
          <TopEarners
            tenantId={membership.tenantId}
            currency={membership.tenant.currency}
            days={rangeDays(range)}
          />
        </Suspense>
      )}

      {view === "proof" && (
        <div className="space-y-6">
          <Suspense
            fallback={
              <div role="status" aria-label="Loading impact summary">
                <SkeletonCard lines={3} />
              </div>
            }
          >
            <ImpactCard tenantId={membership.tenantId} />
          </Suspense>
          <Suspense
            fallback={
              <div role="status" aria-label="Loading forecast scorecard">
                <SkeletonCard lines={3} />
              </div>
            }
          >
            <ForecastScorecard
              tenantId={membership.tenantId}
              canRunCheck={hasPermission(membership, "manage_settings")}
            />
          </Suspense>
          <Suspense
            fallback={
              <div role="status" aria-label="Loading stockout trend">
                <SkeletonCard lines={3} />
              </div>
            }
          >
            <StockoutTrend tenantId={membership.tenantId} weeks={rangeWeeks(range)} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
