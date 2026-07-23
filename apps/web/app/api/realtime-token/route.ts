import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";

/**
 * Connection details for the realtime gateway: { url, token, workspaceId }.
 *
 * The token is the caller's own Better Auth session token — the raw value
 * inside the httpOnly cookie this request just authenticated with. The gateway
 * validates it the same way the app does (a Session-table lookup, then tenant
 * via Membership), so this hands the browser no credential it didn't already
 * hold; it only re-surfaces it because a WebSocket to another origin cannot
 * carry the httpOnly cookie.
 *
 * url carries the ACTIVE workspace as its `workspace` query parameter, so the
 * socket binds to the tenant the shell is showing — the gateway honors it only
 * after checking the session's memberships. url is null when no gateway is
 * configured or the user has no workspace — the client hooks stay idle.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const membership = await activeMembership(session.user.id);
  const base = process.env.NEXT_PUBLIC_WS_URL ?? null;
  const url =
    base && membership
      ? `${base}?workspace=${encodeURIComponent(membership.tenantId)}`
      : null;
  return NextResponse.json({
    url,
    token: session.session.token,
    workspaceId: membership?.tenantId ?? null,
  });
}
