import { prismaForTenant } from "@wezesha/db";

/**
 * Notification-feed queries. Server-only: every function takes an explicit
 * tenantId and runs on the RLS-enforced tenant client, so the feed can never
 * surface (or mark read) another tenant's rows.
 *
 * The feed is also money-blind: kinds whose subject is a buying cost are
 * filtered out for a caller without cost visibility. A notification is a stored
 * string, written once and read back by paths that don't know the reader's
 * permissions, so the filter is what keeps rows written before the wording
 * changed — some of which still carry a percentage in the title — away from a
 * member. Marking read is not filtered: a member can only pass ids from a page
 * they were served, and mark-all is a bulk state change, not a disclosure.
 */

/** Notification kinds that are about what the shop pays, not what it sells.
 *  Their very existence is a cost fact ("this product's cost jumped"), so the
 *  whole row stays out of a money-blind caller's feed. */
const COST_BEARING_KINDS = ["cost_moved"];

/** Feed filter for the caller's cost visibility — empty for a cost viewer. */
const visibleKindsWhere = (canViewCosts: boolean) =>
  canViewCosts ? {} : { kind: { notIn: COST_BEARING_KINDS } };

/** What the feed API serializes — createdAt/readAt as ISO strings. */
export type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationPage = {
  items: NotificationItem[];
  /** Pass back as `cursor` to fetch the next (older) page; null at the end. */
  nextCursor: string | null;
};

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** Clamp a raw ?limit= value into [1, MAX_PAGE_SIZE]; default when absent/junk. */
export function clampLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/** Unread notifications for the bell badge, counting only what the caller's feed
 *  would show. `canViewCosts` defaults to the full count so an unchanged caller
 *  keeps today's badge: a bare count carries no cost figure, but it should match
 *  the page below, so pass the caller's real permission. */
export async function getUnreadCount(
  tenantId: string,
  { canViewCosts = true }: { canViewCosts?: boolean } = {}
): Promise<number> {
  return prismaForTenant(tenantId).notification.count({
    where: { readAt: null, ...visibleKindsWhere(canViewCosts) },
  });
}

/** Newest-first page of the tenant's feed, cursor-paginated by row id. The
 *  caller's cost visibility is required, not defaulted — the page carries stored
 *  titles, so forgetting it would be the leak. */
export async function listNotifications(
  tenantId: string,
  {
    cursor,
    limit = DEFAULT_PAGE_SIZE,
    canViewCosts,
  }: { cursor?: string | null; limit?: number; canViewCosts: boolean }
): Promise<NotificationPage> {
  const rows = await prismaForTenant(tenantId).notification.findMany({
    where: visibleKindsWhere(canViewCosts),
    // id is a cuid — created-at ties break deterministically on it.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1, // one extra row = "there is a next page"
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, kind: true, title: true, body: true, readAt: true, createdAt: true },
  });

  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Mark specific notifications read. Ids from other tenants are invisible to
 *  the tenant client, so they simply don't count. Returns rows updated. */
export async function markNotificationsRead(
  tenantId: string,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await prismaForTenant(tenantId).notification.updateMany({
    where: { id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

/** Mark the whole feed read. Returns rows updated. */
export async function markAllNotificationsRead(tenantId: string): Promise<number> {
  const result = await prismaForTenant(tenantId).notification.updateMany({
    where: { readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}
