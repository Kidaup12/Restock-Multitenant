import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import {
  markAllNotificationsRead,
  markNotificationsRead,
} from "@/lib/notifications/data";
import { withCapture } from "@/lib/observability/wrap";

/** Ids arrive from the client's own feed page — bound the batch anyway. */
const MAX_IDS = 100;

/**
 * Mark notifications read for the active workspace. Body is either
 * { all: true } or { ids: string[] }. Ids outside the tenant are invisible to
 * the RLS-scoped client, so a forged id is a no-op, not an error.
 * Response: { updated }.
 */
export const POST = withCapture(async (request: Request) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const membership = await activeMembership(session.user.id);
  if (!membership) {
    return NextResponse.json({ error: "no workspace" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { all, ids } = (body ?? {}) as { all?: unknown; ids?: unknown };
  if (all === true) {
    const updated = await markAllNotificationsRead(membership.tenantId);
    return NextResponse.json({ updated });
  }
  if (
    Array.isArray(ids) &&
    ids.length <= MAX_IDS &&
    ids.every((id) => typeof id === "string" && id.length > 0)
  ) {
    const updated = await markNotificationsRead(membership.tenantId, ids);
    return NextResponse.json({ updated });
  }
  return NextResponse.json({ error: "invalid body" }, { status: 400 });
});
