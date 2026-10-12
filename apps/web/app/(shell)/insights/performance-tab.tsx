import { Suspense } from "react";

import { SkeletonCard, SkeletonTableRows } from "@/components/ui/skeleton";
import type { AbcKey } from "@/lib/data/abc-lens";

import { ImpactCard } from "./impact-card";
import { BeforeAfter } from "./before-after";
import { ForecastScorecard } from "./forecast-scorecard";
import { StockoutTrend } from "./stockout-trend";
import { MissedRevenueSection } from "./missed-revenue";
import { LeakageMatrixSection } from "./leakage-matrix";
import { PeriodTable } from "./period-table";

/**
 * The Performance tab — "is it actually working?" — as one component the page
 * can drop in a single place.
 *
 * It is a pure re-composition: the same proof panels the page rendered inline,
 * in the same order and with the same props, each behind its own Suspense so a
 * slow loader shows a skeleton in that panel's place rather than blocking the
 * whole tab. Nothing here fetches or reshapes — it only threads props down, so
 * the sub-components stay the single source of truth for what each shows.
 *
 * The window props are split on purpose. Most panels want `weeks`, but the
 * scorecard grades whole elapsed horizons and takes `windowDays`; deriving both
 * from `range` is the page's job, so both arrive already computed and this
 * wrapper stays a thin pass-through. `canRunCheck` is the scorecard's own gate
 * (manage_settings), kept distinct from `canViewCosts` which nulls cost figures
 * for a money-blind member in the leakage matrix.
 */
export function PerformanceTab({
  tenantId,
  currency,
  canViewCosts,
  canRunCheck,
  weeks,
  windowDays,
  abc,
}: {
  tenantId: string;
  currency: string;
  /** Nulls cost figures for a money-blind member — leakage matrix's gate. */
  canViewCosts: boolean;
  /** May the caller trigger the accuracy check — the scorecard's own gate. */
  canRunCheck: boolean;
  /** Whole weeks in the report's period, for the week-bucketed panels. */
  weeks: number;
  /** Days in the report's period, for the horizon-graded scorecard. */
  windowDays: number;
  /** The A/B/C lens from the URL — filters the sections that honour it. */
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
        {/* The table cut of the impact card's two numbers — before against
            now, with the direction coloured. */}
        <BeforeAfter tenantId={tenantId} />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading forecast scorecard">
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <ForecastScorecard
          tenantId={tenantId}
          canRunCheck={canRunCheck}
          windowDays={windowDays}
        />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading stockout trend">
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <StockoutTrend tenantId={tenantId} weeks={weeks} />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading sales missed to empty shelves">
            <SkeletonCard lines={5} />
          </div>
        }
      >
        {/* What the empty shelves the chart above counts actually cost in
            sales — a headline, a weekly trend and the worst culprits. A
            sales estimate, so no cost gate; honours the same ABC lens. */}
        <MissedRevenueSection
          tenantId={tenantId}
          currency={currency}
          weeks={weeks}
          abc={abc}
        />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading where it's leaking">
            <SkeletonTableRows rows={6} />
          </div>
        }
      >
        {/* The same loss, grouped: which category or class leaks most, by
            stockouts, dead stock and missed sales. Capital tied up is a
            cost and drops for a money-blind member. */}
        <LeakageMatrixSection
          tenantId={tenantId}
          currency={currency}
          weeks={weeks}
          canViewCosts={canViewCosts}
        />
      </Suspense>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading week-by-week metrics">
            <SkeletonTableRows rows={6} />
          </div>
        }
      >
        {/* The chart says which weeks were bad; this says which products
            made them so. */}
        <PeriodTable tenantId={tenantId} weeks={weeks} abc={abc} />
      </Suspense>
    </div>
  );
}
