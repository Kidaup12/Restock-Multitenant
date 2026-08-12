import { CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";

/**
 * Fleet queries for the admin console — the sanctioned cross-tenant read
 * module. Everything here runs on the service client BY DESIGN: the console's
 * job is to see every tenant at once (sync health, connection state, open
 * alerts), which no tenant-scoped client can do. Every entry point is reached
 * only through requireAdmin()/adminFromHeaders(); nothing in here is imported
 * by tenant-facing pages.
 */

export const SYNC_RESOURCES = ["products", "inventory", "orders"] as const;
export type SyncResource = (typeof SYNC_RESOURCES)[number];

/** The staleness rule now lives in `lib/sync/staleness.ts` because the SHOP is
 *  told as well as the operator — re-exported so this module stays the fleet's
 *  single import and the two surfaces cannot drift to different thresholds. */
export { STALE_AFTER_MS, isStale } from "@/lib/sync/staleness";

/** "paused" is a store the app still holds a connection for but has stopped
 *  syncing, because its token kept being refused. It reported as "live" until
 *  this existed, which is the most misleading answer available: the fleet is
 *  the one screen whose job is to show that a shop's data has stopped moving. */
export type ConnectionState = "live" | "paused" | "uninstalled" | "none";

export type FleetRow = {
  tenantId: string;
  name: string;
  slug: string;
  createdAt: Date;
  memberCount: number;
  productCount: number;
  connection: { state: ConnectionState; shopDomain: string | null };
  /** Cursor timestamp per resource; null = never synced. */
  lastSync: Record<SyncResource, Date | null>;
  /** Worst (oldest) resource age for a connected tenant, in ms; null when the
   *  tenant has no live connection (nothing to be stale). Infinity = connected
   *  but a resource has never synced. */
  stalenessMs: number | null;
  openNotifications: number;
  lastForecastRunAt: Date | null;
};

/** A store the app holds a usable connection row for. Paused counts: its data
 *  exists and is going stale, which is precisely what the fleet must show — it
 *  is the difference between "no store here" and "this store stopped moving". */
export function isConnected(state: ConnectionState): boolean {
  return state === "live" || state === "paused";
}

function worstStaleness(
  state: ConnectionState,
  lastSync: Record<SyncResource, Date | null>,
  now: number
): number | null {
  if (!isConnected(state)) return null;
  let worst = 0;
  for (const resource of SYNC_RESOURCES) {
    const at = lastSync[resource];
    const age = at ? now - at.getTime() : Infinity;
    if (age > worst) worst = age;
  }
  return worst;
}

/** Every customer workspace with its sync health, one row each. */
export async function getFleet(now: number = Date.now()): Promise<FleetRow[]> {
  // Cross-tenant on purpose: the fleet view is the whole point of this module
  // (see file header). Four queries total, joined in memory by tenantId.
  const [tenants, cursors, unread, forecastRuns] = await Promise.all([
    prismaService.tenant.findMany({
      // The platform workspace is ours, not a shop: it has no connection and
      // never syncs, so it would sit at the top of a list sorted by staleness.
      where: CUSTOMER_TENANTS_WHERE,
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { memberships: true, products: true } },
        shopifyConnection: {
          select: { shopDomain: true, uninstalledAt: true, syncPausedAt: true },
        },
      },
    }),
    prismaService.ingestCursor.findMany({
      select: { tenantId: true, resource: true, cursor: true },
    }),
    prismaService.notification.groupBy({
      by: ["tenantId"],
      where: { readAt: null },
      _count: { _all: true },
    }),
    prismaService.prediction.groupBy({
      by: ["tenantId"],
      _max: { runDate: true },
    }),
  ]);

  const cursorsByTenant = new Map<string, Map<string, Date>>();
  for (const c of cursors) {
    const forTenant = cursorsByTenant.get(c.tenantId) ?? new Map<string, Date>();
    forTenant.set(c.resource, c.cursor);
    cursorsByTenant.set(c.tenantId, forTenant);
  }
  const unreadByTenant = new Map(unread.map((n) => [n.tenantId, n._count._all]));
  const runByTenant = new Map(forecastRuns.map((r) => [r.tenantId, r._max.runDate]));

  return tenants.map((t) => {
    const state: ConnectionState = !t.shopifyConnection
      ? "none"
      : t.shopifyConnection.uninstalledAt
        ? "uninstalled"
        : t.shopifyConnection.syncPausedAt
          ? "paused"
          : "live";
    const tenantCursors = cursorsByTenant.get(t.id);
    const lastSync = Object.fromEntries(
      SYNC_RESOURCES.map((r) => [r, tenantCursors?.get(r) ?? null])
    ) as Record<SyncResource, Date | null>;

    return {
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      createdAt: t.createdAt,
      memberCount: t._count.memberships,
      productCount: t._count.products,
      connection: { state, shopDomain: t.shopifyConnection?.shopDomain ?? null },
      lastSync,
      stalenessMs: worstStaleness(state, lastSync, now),
      openNotifications: unreadByTenant.get(t.id) ?? 0,
      lastForecastRunAt: runByTenant.get(t.id) ?? null,
    };
  });
}

export type FleetSort = "staleness" | "name" | "created";

/** Dashboard ordering. Staleness = most-stale first (never-synced worst of
 *  all), tenants with nothing to sync at the bottom. */
export function sortFleet(rows: FleetRow[], sort: FleetSort): FleetRow[] {
  const sorted = [...rows];
  if (sort === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === "created") {
    sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  } else {
    sorted.sort((a, b) => (b.stalenessMs ?? -1) - (a.stalenessMs ?? -1));
  }
  return sorted;
}

/** Lightweight id/name list for filter dropdowns (audit view). */
export async function listTenants(): Promise<{ id: string; name: string; slug: string }[]> {
  // Cross-tenant on purpose: the audit filter offers every workspace — and this
  // is the one list the platform workspace belongs in, since the events keyed on
  // it (granting admin, step-up) are exactly what an operator comes here to
  // review. Filtering it out would leave those rows unfilterable.
  return prismaService.tenant.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, slug: true },
  });
}

export type TenantMemberRow = {
  membershipId: string;
  role: string;
  displayName: string | null;
  email: string;
  userName: string;
  createdAt: Date;
};

/**
 * One tenant's identity + membership roster for the workspace detail page.
 * Service client, always filtered by the id the caller resolved from the
 * signed workspace grant: memberships must join the global User table (email),
 * which the tenant-scoped role has no business reading.
 */
export async function getTenantDetail(tenantId: string) {
  const [tenants, members] = await Promise.all([
    prismaService.tenant.findMany({ where: { id: tenantId, ...CUSTOMER_TENANTS_WHERE } }),
    prismaService.membership.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { email: true, name: true } } },
    }),
  ]);
  const tenant = tenants[0];
  if (!tenant) return null;

  return {
    tenant,
    members: members.map(
      (m): TenantMemberRow => ({
        membershipId: m.id,
        role: m.role,
        displayName: m.displayName,
        email: m.user.email,
        userName: m.user.name,
        createdAt: m.createdAt,
      })
    ),
  };
}

/**
 * Is this a customer workspace an operator may act on? Entry validation for
 * impersonation, the sync trigger and tier changes.
 *
 * The platform workspace answers no. It is a real Tenant row, so an id typed
 * into any of those forms would otherwise pass — and entering it or moving it
 * between billing tiers is meaningless at best.
 */
export async function customerWorkspaceExists(tenantId: string): Promise<boolean> {
  // Existence probe by primary key — scoped to exactly one tenant id.
  const rows = await prismaService.tenant.findMany({
    where: { id: tenantId, ...CUSTOMER_TENANTS_WHERE },
    select: { id: true },
  });
  return rows.length > 0;
}
