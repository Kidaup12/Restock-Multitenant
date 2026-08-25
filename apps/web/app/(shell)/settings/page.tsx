import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  BoxIcon,
  CalendarIcon,
  BanknoteIcon,
  BellIcon,
  ChartIcon,
  ChevronRightIcon,
  GearIcon,
  LayersIcon,
  UsersIcon,
} from "@/components/icons";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard } from "@/components/ui/skeleton";
import { activeMembership, requireSession } from "@/lib/auth";
import { readTermsAcceptance } from "@/lib/auth/terms";
import { TERMS_VERSION } from "@/lib/legal";
import { TermsAcceptance } from "./terms-acceptance";
import { getConnectionStatus } from "@/lib/data/connection-status";
import { getSettingsOverview } from "@/lib/data/settings-overview";
import { getTenantPlan } from "@/lib/capabilities";
import {
  PLAN_ORDER,
  PLAN_TIER_LABEL,
  type PlanTier,
} from "@/lib/capabilities/plan-features";
import { planFreshnessLabel } from "@/lib/data/forecast-freshness";
import { RunForecastButton } from "../today/run-forecast-button";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * A hub that answers "is this set up?" on the page, rather than six links you
 * have to open one by one to find out. Each row keeps its drill-down — the
 * editing still lives on its own screen — but carries the one fact the owner
 * came to check.
 */

const CONNECTION_STATUS: Record<string, string> = {
  live: "Connected and syncing",
  paused: "Paused — the store keeps refusing our access",
  uninstalled: "Disconnected — nothing is syncing",
  none: "No store connected yet",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function SettingsSections({
  tenantId,
  acceptance,
}: {
  tenantId: string;
  acceptance: { at: Date | null; version: string | null; current: boolean };
}) {
  const [connection, overview, plan] = await Promise.all([
    getConnectionStatus(tenantId),
    getSettingsOverview(tenantId),
    getTenantPlan(tenantId),
  ]);

  const sections = [
    {
      href: "/settings/workspace",
      icon: <GearIcon />,
      title: "Workspace",
      description: "Name, trading day, alert email, dead stock, and how you buy.",
      status: null,
    },
    {
      href: "/settings/notifications",
      icon: <BellIcon />,
      title: "Your emails",
      description: "Which messages this workspace sends to you. Teammates choose their own.",
      status: null,
    },
    {
      href: "/settings/plan",
      icon: <BanknoteIcon />,
      title: "Plan",
      description: "What this workspace's plan includes, and what the next one adds.",
      status: PLAN_TIER_LABEL[(PLAN_ORDER.find((t) => t === plan) ?? "starter") as PlanTier],
    },
    {
      href: "/settings/connections",
      icon: <LayersIcon />,
      title: "Connections",
      description: "Connect your Shopify store and check how recently it synced.",
      status: CONNECTION_STATUS[connection.state] ?? null,
      // The one row where the status IS the reason to visit, so it leads.
      alert: connection.state !== "live",
    },
    {
      href: "/settings/locations",
      icon: <BoxIcon />,
      title: "Locations",
      description: "What each location does for your stock math — sells, holds, ignores.",
      status: overview.locations > 0 ? plural(overview.locations, "location", "locations") : "None set up",
      alert: overview.locations === 0,
    },
    {
      href: "/settings/team",
      icon: <UsersIcon />,
      title: "Team",
      description: "Invite teammates, set roles, and remove access.",
      status: plural(overview.teamMembers, "person", "people"),
    },
    {
      href: "/settings/pos",
      icon: <ChartIcon />,
      title: "Till sales",
      description: "Send in-store sales to Wezesha, so the forecast sees the whole shop.",
      status: overview.hasTillSales ? "Receiving till sales" : "No till sales received yet",
    },
    {
      href: "/settings/signals",
      icon: <CalendarIcon />,
      title: "Promotions & closures",
      description:
        "Days that weren't normal trading — so a giveaway doesn't inflate every order after it.",
      status: overview.signals > 0 ? plural(overview.signals, "day recorded", "days recorded") : "None recorded",
    },
  ];

  const freshness = overview.lastForecastRun
    ? planFreshnessLabel(overview.lastForecastRun)
    : null;

  return (
    <>
      <Card>
        <CardHeader
          title="Forecast"
          subtitle={
            freshness
              ? freshness.text
              : "No forecast has run for this workspace yet — run one to build the buy list."
          }
          action={<RunForecastButton />}
        />
      </Card>

      <Card>
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="flex items-center gap-3 border-b border-edge px-5 py-4 transition-colors last:border-0 hover:bg-surface-2"
          >
            <div className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-secondary [&_svg]:size-4.5">
              {section.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">{section.title}</div>
              <div className="truncate text-xs text-ink-muted">{section.description}</div>
            </div>
            {section.status && (
              <span
                className={
                  section.alert
                    ? "hidden shrink-0 text-xs font-medium text-warning sm:block"
                    : "hidden shrink-0 text-xs text-ink-muted sm:block"
                }
              >
                {section.status}
              </span>
            )}
            <ChevronRightIcon className="size-4 shrink-0 text-ink-faint" />
          </Link>
        ))}
      </Card>

      <Card>
        <CardHeader title="Legal" subtitle="The terms this workspace runs under." />
        <div className="space-y-4 px-5 pb-5 text-sm">
          <div>
            <Link href="/terms" className="font-medium text-accent-ink hover:underline">
              Terms &amp; Conditions
            </Link>
            <span className="px-2 text-ink-faint">·</span>
            <Link href="/privacy" className="font-medium text-accent-ink hover:underline">
              Privacy Policy
            </Link>
            <span className="px-2 text-ink-faint">·</span>
            <span className="text-ink-muted">version {TERMS_VERSION}</span>
          </div>
          <div className="border-t border-edge pt-4">
            <TermsAcceptance
              acceptedAt={acceptance.at ? acceptance.at.toISOString() : null}
              acceptedVersion={acceptance.version}
              current={acceptance.current}
              version={TERMS_VERSION}
            />
          </div>
        </div>
      </Card>
    </>
  );
}

export default async function SettingsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Account" title="Settings" description="Workspace, team, and integrations" />
      {membership && (
        <Suspense fallback={<SkeletonCard />}>
          <SettingsSections
            tenantId={membership.tenantId}
            acceptance={readTermsAcceptance(membership)}
          />
        </Suspense>
      )}
    </div>
  );
}
