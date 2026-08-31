import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prismaForTenant } from "@wezesha/db";
import { PageHeader } from "@/components/ui/page-header";
import { activeMembership, requireSession } from "@/lib/auth";
import { canManageConnections } from "@/lib/shopify/membership";
import { toSyncRunView } from "@/lib/shopify/sync-run";
import { ShopifyConnectionCard } from "./shopify-connection-card";

export const metadata: Metadata = {
  title: "Connections",
};

const RESOURCES = ["products", "inventory", "orders"] as const;

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) redirect("/");

  const db = prismaForTenant(membership.tenantId);
  const connection = await db.shopifyConnection.findFirst();
  const cursors = connection
    ? await db.ingestCursor.findMany({ where: { source: "shopify" } })
    : [];
  const cursorByResource = new Map(cursors.map((c) => [c.resource, c.cursor]));
  // The newest run, rendered server-side: a page loaded cold in the middle of a
  // sync must show the sync, not "never".
  const run = connection
    ? await db.syncRun.findFirst({ where: { source: "shopify" }, orderBy: { startedAt: "desc" } })
    : null;
  // Only whether a secret exists, plus the client ID — which is not a secret and
  // travels in the authorize URL anyway. The secret itself never leaves the server.
  const appCredential = await db.shopifyAppCredential.findFirst({ select: { clientId: true } });
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Connections" }]}
        title="Connections"
        description="Data sources connected to this workspace"
      />
      <ShopifyConnectionCard
        connection={
          connection
            ? {
                shopDomain: connection.shopDomain,
                installedAt: formatUtc(connection.installedAt),
                uninstalledAt: connection.uninstalledAt
                  ? formatUtc(connection.uninstalledAt)
                  : null,
                scopes: connection.scopes,
                syncPausedAt: connection.syncPausedAt
                  ? formatUtc(connection.syncPausedAt)
                  : null,
                // Decides which recovery the card offers a broken store — the
                // install round trip cannot complete for a token connection.
                authMode: connection.authMode,
                // Surfaced from the first failure. A credential rejection never
                // opens a run row, so without this the screen had nothing to
                // show but "running".
                lastAuthError: connection.lastAuthError,
                lastAuthErrorAt: connection.lastAuthErrorAt
                  ? formatUtc(connection.lastAuthErrorAt)
                  : null,
              }
            : null
        }
        lastSync={RESOURCES.map((resource) => {
          const cursor = cursorByResource.get(resource);
          return { resource, syncedAt: cursor ? formatUtc(cursor) : null };
        })}
        canManage={canManageConnections({
          userId: session.user.id,
          tenantId: membership.tenantId,
          role: membership.role,
        })}
        justConnected={params.connected === "1"}
        errorCode={params.error ?? null}
        syncRun={toSyncRunView(run, new Date())}
        appCredentialsConfigured={appCredential !== null}
        appClientId={appCredential?.clientId ?? null}
      />
    </div>
  );
}
