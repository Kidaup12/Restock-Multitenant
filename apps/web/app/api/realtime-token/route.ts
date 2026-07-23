import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

/**
 * Connection details for the realtime gateway: { url, token }.
 *
 * The token is the caller's own Better Auth session token — the raw value
 * inside the httpOnly cookie this request just authenticated with. The gateway
 * validates it the same way the app does (a Session-table lookup, then tenant
 * via Membership), so this hands the browser no credential it didn't already
 * hold; it only re-surfaces it because a WebSocket to another origin cannot
 * carry the httpOnly cookie.
 *
 * url is null when no gateway is configured — the client hooks stay idle.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    url: process.env.NEXT_PUBLIC_WS_URL ?? null,
    token: session.session.token,
  });
}
