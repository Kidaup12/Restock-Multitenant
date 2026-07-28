import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { clampLimit, getUnreadCount, listNotifications } from "@/lib/notifications/data";
import { withCapture } from "@/lib/observability/wrap";

/**
 * The bell's feed: newest-first page of the active workspace's notifications
 * plus the current unread count (so the badge can resync on every fetch).
 * Session-guarded; the tenant comes from the membership, never the request.
 *
 * Query: ?cursor=<id> (from a prior page's nextCursor) &limit=<1..50>.
 * Response: { notifications, nextCursor, unread }.
 */
export const GET = withCapture(async (request: Request) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const membership = await activeMembership(session.user.id);
  if (!membership) {
    return NextResponse.json({ error: "no workspace" }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  // Cost-bearing notifications are filtered to the caller's own permission, so
  // the page and the badge agree on what this reader may see.
  const canViewCosts = hasPermission(membership, "view_costs");
  const [page, unread] = await Promise.all([
    listNotifications(membership.tenantId, {
      cursor: params.get("cursor"),
      limit: clampLimit(params.get("limit")),
      canViewCosts,
    }),
    getUnreadCount(membership.tenantId, { canViewCosts }),
  ]);

  return NextResponse.json({
    notifications: page.items,
    nextCursor: page.nextCursor,
    unread,
  });
});
