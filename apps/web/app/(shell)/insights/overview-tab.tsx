import { Suspense } from "react";

import { type AbcKey } from "@/lib/data/abc-lens";
import { rangeDays, type RangeKey } from "@/lib/data/report-range";
import { SkeletonCard } from "@/components/ui/skeleton";

import { ImpactCard } from "./impact-card";
import { OverviewKpis } from "./overview-kpis-section";
import { ClassFilter } from "./class-filter";
import { TopEarners } from "./top-earners";
import { DeadStockSection } from "./dead-stock-section";
import { OnOrderSection } from "./on-order-section";
import { OverstockSection } from "./overstock-section";
import { RevenueBreakdownSection } from "./revenue-breakdown";

/**
 * The Reports OVERVIEW tab — the one-screen answer to "how is the shop doing?",
 * in the order a reader works down it: the difference this has made, the four
 * headline numbers, then the movers, the money asleep, what is inbound, what was
 * over-bought, and where the revenue actually comes from.
 *
 * A composition, not a data component: every panel below is its own server
 * component with its own loader, so each is wrapped in its OWN Suspense boundary
 * and streams in as its query settles rather than the whole tab blocking on the
 * slowest one. The class filter is the exception — it is a nav control, not a
 * data panel, so it renders inline with no fallback.
 *
 * The props are the URL's decoded state, threaded from the page so what crosses
 * into this tree is plain values: `abc` is the class lens, `range` the revenue
 * window (windowed panels take `rangeDays(range)`), and `tab` is carried only so
 * the class filter can rebuild its own links without reaching back to the page.
 * `canViewCosts` is the money-blind gate; the cost-bearing panels honour it
 * themselves. TopEarners takes no `abc` — it filters to a class on the client
 * over the rows it already fetched, so the lens costs it no round trip.
 */
export function OverviewTab({
  tenantId,
  currency,
  canViewCosts,
  abc,
  range,
  tab,
}: {
  tenantId: string;
  currency: string;
  canViewCosts: boolean;
  abc: AbcKey;
  range: RangeKey;
  tab: "overview";
}) {
  const days = rangeDays(range);

  return (
    <div className="space-y-6">
      {/* Has this made a difference? — the two numbers the owner judges by,
          measured since the first order, so it leads the overview. */}
      <Suspense fallback={<SkeletonCard />}>
        <ImpactCard tenantId={tenantId} />
      </Suspense>

      {/* The four headline tiles: last-month revenue, capital tied up, revenue
          at risk, and the ABC mix. */}
      <Suspense fallback={<SkeletonCard />}>
        <OverviewKpis tenantId={tenantId} currency={currency} canViewCosts={canViewCosts} />
      </Suspense>

      {/* The A/B/C lens over the panels below. A nav control, not a data panel —
          rendered inline with no Suspense boundary. */}
      <ClassFilter abc={abc} tab={tab} range={range} />

      {/* Top movers: which products actually bring the money in, over the
          selected window. ABC-lensed on the client, so it takes no `abc`. */}
      <Suspense fallback={<SkeletonCard />}>
        <TopEarners tenantId={tenantId} currency={currency} days={days} />
      </Suspense>

      {/* Cash asleep — stock that has not sold, honouring the class lens. */}
      <Suspense fallback={<SkeletonCard />}>
        <DeadStockSection
          tenantId={tenantId}
          currency={currency}
          canViewCosts={canViewCosts}
          abc={abc}
        />
      </Suspense>

      {/* On the way — what is already inbound, so an owner does not double-order. */}
      <Suspense fallback={<SkeletonCard />}>
        <OnOrderSection tenantId={tenantId} currency={currency} canViewCosts={canViewCosts} />
      </Suspense>

      {/* Over-bought — the excess above a healthy cover, under the same lens. */}
      <Suspense fallback={<SkeletonCard />}>
        <OverstockSection
          tenantId={tenantId}
          currency={currency}
          canViewCosts={canViewCosts}
          abc={abc}
        />
      </Suspense>

      {/* Where the money comes from — revenue by category and by brand, over the
          selected window. A sales figure, so no cost gate. */}
      <Suspense fallback={<SkeletonCard />}>
        <RevenueBreakdownSection tenantId={tenantId} currency={currency} days={days} />
      </Suspense>
    </div>
  );
}
