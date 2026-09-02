import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prismaForTenant } from "@wezesha/db";
import { PageHeader } from "@/components/ui/page-header";
import { activeMembership, requireSession } from "@/lib/auth";
import { platformAppCredentials } from "@/lib/shopify/credentials";
import { canManageConnections } from "@/lib/shopify/membership";
import { toSyncRunView } from "@/lib/shopify/sync-run";
import { ShopifyConnectionCard } from "./shopify-connection-card";
import { QuickBooksConnectionCard } from "./quickbooks-connection-card";

export const metadata: Metadata = {
  title: "Connections",
};

const RESOURCES = ["products", "inventory", "orders"] as const;

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Query-string outcomes from the install round trip, in the owner's words. */
function quickBooksNotice(
  ok: string | null,
  error: string | null
): { kind: "ok" | "error"; text: string } | null {
  if (ok === "connected") return { kind: "ok", text: "QuickBooks connected." };
  if (!error) return null;
  const messages: Record<string, string> = {
    not_configured: "QuickBooks is not set up on this deployment yet.",
    forbidden: "Only owners and admins can connect QuickBooks.",
    invalid_state: "That connection attempt expired. Try again.",
    missing_code: "QuickBooks did not send an authorization code. Try again.",
    missing_realm: "QuickBooks did not say which company to connect. Try again.",
    exchange_failed: "QuickBooks rejected the connection. Try again.",
  };
  return { kind: "error", text: messages[error] ?? "Could not connect QuickBooks." };
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    qb?: string;
    qb_error?: string;
  }>;
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
  const quickBooks = await db.quickBooksConnection.findFirst();
  // Only whether the platform app has credentials — the secret never leaves the
  // server, and without them "Connect" would send the owner to a handshake that
  // cannot complete.
  const quickBooksConfigured = Boolean(
    process.env.QUICKBOOKS_CLIENT_ID && process.env.QUICKBOOKS_CLIENT_SECRET
  );
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
        // Whether this deployment has a Wezesha-owned app to install with. Only
        // whether one EXISTS travels to the client; the secret stays server-side.
        platformAppConfigured={platformAppCredentials() !== null}
        appClientId={appCredential?.clientId ?? null}
      />
      <QuickBooksConnectionCard
        connection={
          quickBooks
            ? {
                realmId: quickBooks.realmId,
                connectedAt: formatUtc(quickBooks.connectedAt),
                disconnectedAt: quickBooks.disconnectedAt
                  ? formatUtc(quickBooks.disconnectedAt)
                  : null,
                syncPausedAt: quickBooks.syncPausedAt
                  ? formatUtc(quickBooks.syncPausedAt)
                  : null,
                lastAuthError: quickBooks.lastAuthError,
              }
            : null
        }
        canManage={canManageConnections({
          userId: session.user.id,
          tenantId: membership.tenantId,
          role: membership.role,
        })}
        configured={quickBooksConfigured}
        notice={quickBooksNotice(params.qb ?? null, params.qb_error ?? null)}
      />
    </div>
  );
}
