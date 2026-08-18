import type { Metadata } from "next";
import { prismaForTenant } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { ChartIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PosSetupView } from "./pos-view";

export const metadata: Metadata = {
  title: "Till sales",
};

/**
 * Connect a shop's physical till.
 *
 * The screens that consume this — the unmatched queue, gap detection,
 * reconciliation — have existed for a while; what was missing was any way to
 * turn the feed on without an engineer. In this market most sales happen over
 * the counter, so a run rate built from online orders alone is not a partial
 * answer, it is a confident wrong one.
 */
export default async function PosSettingsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Settings" title="Till sales" description="Send in-store sales to Wezesha" />
        <EmptyState
          icon={<ChartIcon />}
          title="No workspace"
          description="You're not a member of any workspace yet. Ask an admin for an invite."
        />
      </div>
    );
  }

  const config = await prismaForTenant(membership.tenantId).tenantConfig.findUnique({
    where: { tenantId: membership.tenantId },
    select: { posFeedSlug: true, posIngestSecretHash: true },
  });

  // The endpoint a bridge posts to. BETTER_AUTH_URL is the app's own origin —
  // the same one invite links are built from — so this shows the address that
  // will actually work rather than one assembled from a guess.
  const origin = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Till sales" }]}
        title="Till sales"
        description="Send what you sell over the counter, so the forecast sees the whole shop"
      />
      <PosSetupView
        canManage={hasPermission(membership, "manage_settings")}
        // The hash never leaves the server; the screen only needs to know
        // whether one exists.
        configured={Boolean(config?.posIngestSecretHash)}
        feedSlug={config?.posFeedSlug ?? null}
        workspaceSlug={membership.tenant.slug}
        ingestUrl={origin ? `${origin}/api/pos/ingest` : "/api/pos/ingest"}
      />
    </div>
  );
}
