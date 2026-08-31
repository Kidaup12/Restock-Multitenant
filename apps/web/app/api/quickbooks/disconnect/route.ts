import { NextResponse } from "next/server";
import { disconnect } from "@/lib/quickbooks/connection";
import { canManageConnections, tenantActor } from "@/lib/shopify/membership";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Hands the grant back to Intuit and clears the workspace's connection.
 *
 * POST, not GET: disconnecting is a state change and must not be reachable by
 * following a link or a prefetch.
 */
export const POST = withCapture(async () => {
  const actor = await tenantActor();
  if (!actor) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canManageConnections(actor)) {
    return NextResponse.json(
      { error: "Only owners and admins can disconnect QuickBooks." },
      { status: 403 }
    );
  }

  // `revoked` says whether Intuit accepted the revoke. The local row is cleared
  // either way, so the screen can report what actually happened rather than
  // implying the stronger outcome.
  const { revoked } = await disconnect(actor.tenantId);
  return NextResponse.json({ disconnected: true, revoked });
}, { route: "/api/quickbooks/disconnect" });
