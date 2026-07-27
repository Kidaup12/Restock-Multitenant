import type { Metadata } from "next";
import { prismaForTenant } from "@wezesha/db";
import { METHOD_DEFAULTS, parseOrderMethod } from "@wezesha/forecast";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { DEFAULT_DEAD_STOCK_DAYS } from "@/lib/data/today";
import { GearIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { WorkspaceForm } from "./workspace-form";

/**
 * What a shop owner may set about their own workspace. Deliberately narrow:
 * only fields with a live reader and a meaning the owner can judge.
 *
 * Left out on purpose:
 *  - currency — shown, not editable. Nothing reads Tenant.currency; every
 *    figure renders in KES, so an editable picker would change a stored string
 *    and nothing else.
 *  - notifyPrefs — no reader anywhere, so a toggle here would control nothing.
 *  - serviceLevelZA/B/C, orderCapMultiple — z-scores and a cap multiple. Raw
 *    statistics belong to the engine, not to a shop owner.
 *  - POS feed / plan / limit fields — owned by Connections and the operator
 *    console respectively.
 *
 * A tenant with no TenantConfig row reads as all-defaults here, the same way
 * lib/data/today, lib/capabilities and lib/limits/evaluate treat a null row.
 */

export const metadata: Metadata = {
  title: "Workspace",
};

export default async function WorkspaceSettingsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Workspace" description="Your workspace's basic settings" />
        <EmptyState
          icon={<GearIcon />}
          title="No workspace"
          description="You're not a member of any workspace yet. Ask an admin for an invite."
        />
      </div>
    );
  }

  const db = prismaForTenant(membership.tenantId);
  const [tenant, config, owner] = await Promise.all([
    db.tenant.findUnique({
      where: { id: membership.tenantId },
      select: { name: true, timezone: true, currency: true },
    }),
    db.tenantConfig.findFirst({
      select: {
        alertEmail: true,
        deadStockWindowDays: true,
        methodA: true,
        methodB: true,
        methodC: true,
      },
    }),
    // The same fallback the worker's alert routing uses when alertEmail is
    // blank, so the placeholder tells the truth about where alerts land.
    db.membership.findFirst({
      where: { role: "OWNER" },
      orderBy: { createdAt: "asc" },
      select: { user: { select: { email: true } } },
    }),
  ]);

  // The runtime's own tz database, plus whatever is stored in case an older
  // alias (e.g. "Africa/Asmera") isn't in the canonical list — a value missing
  // from the options would silently render as no selection.
  const timezone = tenant?.timezone ?? "Africa/Nairobi";
  const zones = Intl.supportedValuesOf("timeZone");
  const timezones = zones.includes(timezone) ? zones : [timezone, ...zones];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace"
        description={`Currency, trading day, alerts, and how ${membership.tenant.name} buys`}
      />
      <WorkspaceForm
        initial={{
          name: tenant?.name ?? membership.tenant.name,
          timezone,
          alertEmail: config?.alertEmail ?? "",
          deadStockWindowDays:
            config?.deadStockWindowDays == null ? "" : String(config.deadStockWindowDays),
          methodA: parseOrderMethod(config?.methodA) ?? METHOD_DEFAULTS.A,
          methodB: parseOrderMethod(config?.methodB) ?? METHOD_DEFAULTS.B,
          methodC: parseOrderMethod(config?.methodC) ?? METHOD_DEFAULTS.C,
        }}
        timezones={timezones}
        currency={tenant?.currency ?? "KES"}
        defaultDeadStockDays={DEFAULT_DEAD_STOCK_DAYS}
        fallbackAlertEmail={owner?.user.email ?? null}
        canManage={hasPermission(membership, "manage_settings")}
      />
    </div>
  );
}
