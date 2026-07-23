import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prismaForTenant } from "@wezesha/db";
import { PageHeader } from "@/components/ui/page-header";
import { activeMembership, requireSession } from "@/lib/auth";
import { canManageConnections } from "@/lib/shopify/membership";
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
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
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
      />
    </div>
  );
}
