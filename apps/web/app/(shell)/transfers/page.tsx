import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { LayersIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { SkeletonCard, SkeletonStatTile, SkeletonTableRows } from "@/components/ui/skeleton";
import {
  getTenantPlan,
  planAllows,
  planFeatureTier,
  PLAN_TIER_LABEL,
} from "@/lib/capabilities";
import {
  clampCoverDays,
  COVER_DAY_CHOICES,
  DEFAULT_COVER_DAYS,
  getTransferLocations,
  parseSavedPlansQuery,
} from "@/lib/data/transfers";
import { ProposalView } from "./proposal-view";
import { SavedPlans } from "./saved-plans";

export const metadata: Metadata = {
  title: "Transfers",
};

/** Source and cover-horizon pills are plain links: the whole screen is a server
 *  render of a searchParams state, so a picked source survives a refresh and can
 *  be shared with whoever is doing the picking. */
function Pill({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-accent-soft text-accent-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
      )}
    >
      {label}
    </Link>
  );
}

/** Growth-tier lock: shown, not hidden, so the owner can see what they'd get. */
function LockedTransfers() {
  const tier = PLAN_TIER_LABEL[planFeatureTier("transfers")];
  return (
    <div aria-disabled="true" className="rounded-lg border border-edge bg-surface p-5 text-left opacity-75">
      <div className="grid size-9 place-items-center rounded-md bg-surface-2 text-ink-muted [&_svg]:size-4.5">
        <LayersIcon />
      </div>
      <h2 className="mt-3 font-display text-base font-semibold text-ink">Move stock between branches</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Build a plan that says exactly what to move from the warehouse to each shop, sized so every
        shop ends up with the same days of cover at its own selling rate.
      </p>
      <p className="mt-3 text-sm font-medium text-accent-ink">Unlock on {tier}.</p>
    </div>
  );
}

async function TransfersContent({
  tenantId,
  canViewCosts,
  canPlan,
  from,
  coverDays,
}: {
  tenantId: string;
  canViewCosts: boolean;
  canPlan: boolean;
  from?: string;
  coverDays: number;
}) {
  const [plan, locations] = await Promise.all([getTenantPlan(tenantId), getTransferLocations(tenantId)]);
  if (!planAllows(plan, "transfers")) return <LockedTransfers />;

  // One location can't distribute to anything — the whole idea needs a second.
  if (locations.length < 2) {
    return (
      <EmptyState
        icon={<LayersIcon />}
        title="Only one location"
        description="Transfers compare how fast each shop sells and move stock to even out cover. Add a second location — a shop or a warehouse — and the plan builds itself."
      />
    );
  }

  const source = locations.find((l) => l.locationId === from) ?? locations[0]!;
  const query = (next: { from?: string; cover?: number }) =>
    `/transfers?from=${next.from ?? source.locationId}&cover=${next.cover ?? coverDays}`;

  return (
    <div className="space-y-6">
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium tracking-wider text-ink-muted uppercase">Move from</span>
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge bg-surface p-1">
            {locations.map((location) => (
              <Pill
                key={location.locationId}
                href={query({ from: location.locationId })}
                label={location.name}
                active={location.locationId === source.locationId}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium tracking-wider text-ink-muted uppercase">Cover target</span>
          <div className="flex items-center gap-1 rounded-lg border border-edge bg-surface p-1">
            {COVER_DAY_CHOICES.map((days) => (
              <Pill
                key={days}
                href={query({ cover: days })}
                label={`${days}d`}
                active={days === coverDays}
              />
            ))}
          </div>
        </div>
      </Card>

      <Suspense
        key={`${source.locationId}:${coverDays}`}
        fallback={
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SkeletonStatTile />
              <SkeletonStatTile />
              <SkeletonStatTile />
              <SkeletonStatTile />
            </div>
            <Card className="p-5">
              <SkeletonTableRows rows={8} />
            </Card>
          </div>
        }
      >
        <ProposalView
          tenantId={tenantId}
          fromLocationId={source.locationId}
          coverDays={coverDays}
          canViewCosts={canViewCosts}
          canPlan={canPlan}
        />
      </Suspense>
    </div>
  );
}

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; cover?: string; q?: string; page?: string }>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const params = await searchParams;

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Transfers" description="Move stock to the shops that will sell it" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to plan its transfers."
        />
      </div>
    );
  }

  const canViewCosts = hasPermission(membership, "view_costs");
  const canPlan = hasPermission(membership, "approve_orders");
  const coverDays = clampCoverDays(params.cover ? Number(params.cover) : DEFAULT_COVER_DAYS);
  // The proposal's own state, kept whole across a plan search or page turn.
  const carry = [
    ...(params.from ? [{ name: "from", value: params.from }] : []),
    { name: "cover", value: String(coverDays) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transfers"
        description="Move stock to the shops that will sell it"
      />

      <Suspense fallback={<SkeletonCard lines={3} />}>
        <TransfersContent
          tenantId={membership.tenantId}
          canViewCosts={canViewCosts}
          canPlan={canPlan}
          from={params.from}
          coverDays={coverDays}
        />
      </Suspense>

      <Suspense fallback={<SkeletonCard lines={3} />}>
        <SavedPlans
          tenantId={membership.tenantId}
          canViewCosts={canViewCosts}
          canPlan={canPlan}
          carry={carry}
          query={parseSavedPlansQuery(params)}
        />
      </Suspense>
    </div>
  );
}
