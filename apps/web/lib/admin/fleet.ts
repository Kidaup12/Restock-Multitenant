import { CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";
import { STRANDED_RUN_AFTER_MS } from "@wezesha/queue";

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
  /**
   * Runs that ended in an error inside the failure window, and the newest
   * message among them.
   *
   * The fleet used to read cursors alone, which move only on SUCCESS — so a
   * store failing every fifteen minutes looked identical to a healthy one for a
   * full day, until the 24-hour staleness line finally tripped. Two production
   * tenants had accumulated ~250 failed runs each that this screen never showed.
   */
  recentFailures: number;
  lastError: string | null;
  /**
   * Runs still marked `running` long after any real sync would have finished.
   * The processor closes its row on both paths, so one of these means the
   * worker was killed mid-flight — a redeploy, almost always. Harmless to the
   * data, but they are the difference between "syncing now" and "died an hour
   * ago", and nothing else surfaces them.
   */
  strandedRuns: number;
};

/** How far back a failed run still counts as news. Shorter than the staleness
 *  line on purpose: failures are the early warning, staleness is the symptom
 *  that eventually follows. */
export const FAILURE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Abandoned-run threshold — shared with the worker that closes them, so the
 *  screen and the sweep cannot disagree about what counts as abandoned. */
export { STRANDED_RUN_AFTER_MS as STRANDED_AFTER_MS } from "@wezesha/queue";

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
  const [tenants, cursors, unread, forecastRuns, troubleRuns] = await Promise.all([
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
    // Failures and abandoned runs, the two things cursors can never report.
    prismaService.syncRun.findMany({
      where: {
        OR: [
          { status: "failed", startedAt: { gte: new Date(now - FAILURE_WINDOW_MS) } },
          { status: "running", startedAt: { lt: new Date(now - STRANDED_RUN_AFTER_MS) } },
        ],
      },
      select: { tenantId: true, status: true, error: true, startedAt: true },
      orderBy: { startedAt: "desc" },
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

  // Ordered newest-first by the query, so the first error seen per tenant is the
  // latest one.
  const failuresByTenant = new Map<string, { count: number; error: string | null }>();
  const strandedByTenant = new Map<string, number>();
  for (const run of troubleRuns) {
    if (run.status === "failed") {
      const seen = failuresByTenant.get(run.tenantId);
      failuresByTenant.set(run.tenantId, {
        count: (seen?.count ?? 0) + 1,
        error: seen?.error ?? run.error,
      });
    } else {
      strandedByTenant.set(run.tenantId, (strandedByTenant.get(run.tenantId) ?? 0) + 1);
    }
  }

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
      recentFailures: failuresByTenant.get(t.id)?.count ?? 0,
      lastError: failuresByTenant.get(t.id)?.error ?? null,
      strandedRuns: strandedByTenant.get(t.id) ?? 0,
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
    // Health, not just age. A store failing right now is the more urgent row
    // even though its cursor is minutes old — sorting on staleness alone put it
    // at the bottom until a full day had passed.
    sorted.sort(
      (a, b) =>
        Number(b.recentFailures > 0) - Number(a.recentFailures > 0) ||
        (b.stalenessMs ?? -1) - (a.stalenessMs ?? -1)
    );
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
