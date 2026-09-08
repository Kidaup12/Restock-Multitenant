import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { CalendarIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard } from "@/components/ui/skeleton";
import { planFreshnessLabel } from "@/lib/data/forecast-freshness";
import { getBuyList } from "@/lib/data/plan";
import { tenantIngestVerdict } from "@wezesha/forecast-run";
import { getConnectionStatus, type ConnectionStatus } from "@/lib/data/connection-status";
import { getTenantPlan, planAllows } from "@/lib/capabilities";
import { RunForecastButton } from "../today/run-forecast-button";
import { PlanView } from "./plan-view";

export const metadata: Metadata = {
  title: "Restock Planner",
};

const onDate = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Why the sales data is old — stated from the connection, not guessed.
 *
 * The old copy here asserted "your sales feed looks stopped" off nothing but the
 * age of the newest sale. On a store that was connected and syncing perfectly it
 * sent someone looking for a broken integration that did not exist. Staleness is
 * a fact about the DATA; only the connection says whether it is a fault.
 */
function staleSalesNote(connection: ConnectionStatus, latestSaleAt: Date | null): string {
  const since =
    latestSaleAt == null
      ? "No sales have come through yet."
      : `No sales have been recorded since ${onDate(latestSaleAt)}.`;
  const thin = "You can still run a forecast, but it will be thin until sales come through again.";

  if (connection.state === "none") {
    return `${since} No store is connected to this workspace yet — connect one in Settings and its sales history comes with it.`;
  }
  if (connection.state === "uninstalled" || connection.state === "paused") {
    return `${since} This workspace's store connection has stopped, so nothing new can arrive — reconnect it in Settings.`;
  }
  return `${since} The store is connected and still syncing, so this is what it has: the shop itself has recorded no sales in that time. ${thin}`;
}

/** The buy list streams behind its own skeleton; the header paints immediately. */
async function PlanContent({
  tenantId,
  canViewCosts,
  canOverride,
}: {
  tenantId: string;
  canViewCosts: boolean;
  canOverride: boolean;
}) {
  // canViewCosts flows into the query: PlanView is a client component, so the
  // rows serialize to the browser — costs come back null for a money-blind
  // member and the figures never reach the payload.
  const [buyList, plan] = await Promise.all([
    getBuyList(tenantId, { canViewCosts }),
    getTenantPlan(tenantId),
  ]);
  // The budget allocator is an entry-tier feature now, so this is true for every
  // plan — the locked card is unreachable. The gate stays wired (rather than
  // hard-coded true) so moving budgeting back behind a tier is a one-line change,
  // and the server action re-checks either way so it can't be spoofed.
  const canBudget = planAllows(plan, "budget_planner");

  if (!buyList) {
    // The staleness gate holds a run back only to protect a last-good forecast,
    // and there is none here — so the run will proceed and the button is real.
    // What it cannot fix is old sales data, and the shop deserves to know which
    // of the two reasons applies BEFORE it runs one, because the answers are
    // opposite: a store that stopped syncing needs reconnecting, a shop that has
    // simply been quiet needs nothing at all.
    const [ingest, connection] = await Promise.all([
      tenantIngestVerdict(tenantId),
      getConnectionStatus(tenantId),
    ]);
    return (
      <EmptyState
        icon={<CalendarIcon />}
        title="No forecast yet"
        description={
          ingest.stale
            ? staleSalesNote(connection, ingest.latestSaleAt)
            : "Run the forecast to build this week's buy list — every product that needs restocking, with quantities and the reasoning behind them."
        }
        action={<RunForecastButton />}
      />
    );
  }

  // Only a truly empty run gets the empty state. A shop with nothing to buy but
  // 47 products the run covered still has something to read — hiding the whole
  // view would take that away from exactly the shops that need it most.
  if (buyList.rows.length === 0 && buyList.excluded.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon />}
        title="Nothing to order right now"
        description="The latest forecast doesn't recommend restocking anything — the next run may change that."
        action={<RunForecastButton />}
      />
    );
  }

  return (
    <PlanView
      buyList={buyList}
      canViewCosts={canViewCosts}
      canBudget={canBudget}
      canOverride={canOverride}
      freshness={planFreshnessLabel(buyList.runDate)}
    />
  );
}

export default async function PlanPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Buy" title="This week's Buy List" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to plan its restocking."
        />
      </div>
    );
  }

  const canViewCosts = hasPermission(membership, "view_costs");
  const canOverride = hasPermission(membership, "approve_orders");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Buy"
        title="This week's Buy List"
        description="Start from what the forecast recommends, plan against a budget, or look ahead at the ordering calendar."
      />
      <Suspense
        fallback={
          // Three mode cards, on the same grid the real chooser uses.
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
          </div>
        }
      >
        <PlanContent
          tenantId={membership.tenantId}
          canViewCosts={canViewCosts}
          canOverride={canOverride}
        />
      </Suspense>
    </div>
  );
}
