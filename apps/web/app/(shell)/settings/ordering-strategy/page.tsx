import type { Metadata } from "next";
import { prismaForTenant } from "@wezesha/db";
import { METHOD_DEFAULTS, parseOrderMethod, type OrderMethod } from "@wezesha/forecast";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { StrategyClass } from "@/lib/ordering/strategy";
import { StrategyForm } from "./strategy-form";

export const metadata: Metadata = {
  title: "Ordering strategy",
};

/**
 * How hard the buy list works to keep each group in stock.
 *
 * This lived inside the Workspace settings page, below the timezone picker and
 * the dead-stock window, where nobody looking for it would find it. It decides
 * how much cash sits on the shelf against how often the shop runs out — the
 * single most consequential setting an owner has — so it gets its own page and
 * a card on Settings pointing at it.
 *
 * What it does NOT show is the arithmetic. The engine's own note is that raw
 * statistics belong to the engine, not the shop owner; the choice belongs to
 * the owner, and it is described by its effect on the shop.
 */
export default async function OrderingStrategyPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Ordering strategy" }]}
          title="Ordering strategy"
          description="How Wezesha sizes your reorders"
        />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace."
        />
      </div>
    );
  }

  const config = await prismaForTenant(membership.tenantId).tenantConfig.findUnique({
    where: { tenantId: membership.tenantId },
    select: { methodA: true, methodB: true, methodC: true },
  });

  // An unset column means the engine's default is in force, so the form opens on
  // what the buy list is ACTUALLY doing rather than on a blank.
  const initial: Record<StrategyClass, OrderMethod> = {
    A: parseOrderMethod(config?.methodA) ?? METHOD_DEFAULTS.A,
    B: parseOrderMethod(config?.methodB) ?? METHOD_DEFAULTS.B,
    C: parseOrderMethod(config?.methodC) ?? METHOD_DEFAULTS.C,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Ordering strategy" }]}
        title="How Wezesha sizes your reorders"
        description="Choose a style per group. We suggest keeping your best sellers well stocked and leaning on cash for the slow tail — but it's your call. Changes apply on the next forecast run."
      />
      <StrategyForm
        initial={initial}
        canManage={hasPermission(membership, "manage_settings")}
      />
    </div>
  );
}
