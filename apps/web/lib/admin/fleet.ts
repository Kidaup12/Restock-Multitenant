import { prismaService } from "@wezesha/db";

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

/** A resource cursor older than this is flagged stale on the dashboard (M4's
 *  staleness rule surfaced fleet-wide). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type ConnectionState = "live" | "uninstalled" | "none";

/** Never-synced or older than the threshold. Clock lives here, not in
 *  components — react-hooks/purity bans Date.now() during render. */
export function isStale(at: Date | null, now: number = Date.now()): boolean {
  return !at || now - at.getTime() > STALE_AFTER_MS;
}

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

function worstStaleness(
  state: ConnectionState,
  lastSync: Record<SyncResource, Date | null>,
  now: number
): number | null {
  if (state !== "live") return null;
  let worst = 0;
  for (const resource of SYNC_RESOURCES) {
    const at = lastSync[resource];
    const age = at ? now - at.getTime() : Infinity;
    if (age > worst) worst = age;
  }
  return worst;
}

/** Every tenant with its sync health, one row each. */
export async function getFleet(now: number = Date.now()): Promise<FleetRow[]> {
  // Cross-tenant on purpose: the fleet view is the whole point of this module
  // (see file header). Four queries total, joined in memory by tenantId.
  const [tenants, cursors, unread, forecastRuns] = await Promise.all([
    prismaService.tenant.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { memberships: true, products: true } },
        shopifyConnection: { select: { shopDomain: true, uninstalledAt: true } },
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
  // Cross-tenant on purpose: the audit filter offers every workspace.
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
    prismaService.tenant.findMany({ where: { id: tenantId } }),
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

/** Does this tenant exist? Entry validation for impersonation + sync trigger. */
export async function tenantExists(tenantId: string): Promise<boolean> {
  // Existence probe by primary key — scoped to exactly one tenant id.
  const rows = await prismaService.tenant.findMany({
    where: { id: tenantId },
    select: { id: true },
  });
  return rows.length > 0;
}
