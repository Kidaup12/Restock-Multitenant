import { NextResponse } from "next/server";
import { prismaForTenant } from "@wezesha/db";
import { canManageConnections, tenantActor } from "@/lib/shopify/membership";
import { withCapture } from "@/lib/observability/wrap";

/**
 * In-app disconnect: stamps uninstalledAt so syncs and webhooks stop treating
 * the connection as live. The row (and its encrypted token) is kept — Reconnect
 * runs the OAuth flow again and reuses the same row. Merchant-side uninstalls
 * arrive separately via the app/uninstalled webhook.
 */
export const POST = withCapture(async () => {
  const actor = await tenantActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canManageConnections(actor)) {
    return NextResponse.json({ error: "Only owners and admins can disconnect a store." }, { status: 403 });
  }

  const { count } = await prismaForTenant(actor.tenantId).shopifyConnection.updateMany({
    where: { uninstalledAt: null },
    data: { uninstalledAt: new Date() },
  });
  if (count === 0) {
    return NextResponse.json({ error: "No live Shopify connection." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}, { route: "/api/shopify/disconnect" });
