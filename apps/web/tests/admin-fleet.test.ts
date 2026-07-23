import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isStale, sortFleet, STALE_AFTER_MS, type FleetRow } from "../lib/admin/fleet";

/**
 * Fleet dashboard queries against the local database: per-tenant health rows
 * (connection state, per-resource cursor staleness, counts) and the
 * cross-tenant audit listing's filters + pagination. Skips without a local
 * service connection.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const SLUG_A = "admin-fleet-a"; // connected, one fresh + one stale cursor
const SLUG_B = "admin-fleet-b"; // bare: no connection, no members beyond none
const HOUR = 3_600_000;

function fleetStub(overrides: Partial<FleetRow>): FleetRow {
  return {
    tenantId: "t",
    name: "n",
    slug: "s",
    createdAt: new Date(0),
    memberCount: 0,
    productCount: 0,
    connection: { state: "none", shopDomain: null },
    lastSync: { products: null, inventory: null, orders: null },
    stalenessMs: null,
    openNotifications: 0,
    lastForecastRunAt: null,
    ...overrides,
  };
}

describe("sortFleet", () => {
  it("staleness sort puts most-stale first and unconnected tenants last", () => {
    const rows = [
      fleetStub({ tenantId: "fresh", stalenessMs: HOUR }),
      fleetStub({ tenantId: "none", stalenessMs: null }),
      fleetStub({ tenantId: "never", stalenessMs: Infinity }),
      fleetStub({ tenantId: "stale", stalenessMs: 30 * HOUR }),
    ];
    expect(sortFleet(rows, "staleness").map((r) => r.tenantId)).toEqual([
      "never",
      "stale",
      "fresh",
      "none",
    ]);
  });

  it("isStale flags never-synced and >24h cursors", () => {
    const now = Date.now();
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date(now - STALE_AFTER_MS - 1), now)).toBe(true);
    expect(isStale(new Date(now - HOUR), now)).toBe(false);
  });

  it("name and created sorts do what they say", () => {
    const rows = [
      fleetStub({ tenantId: "1", name: "Zed", createdAt: new Date(1000) }),
      fleetStub({ tenantId: "2", name: "Abe", createdAt: new Date(2000) }),
    ];
    expect(sortFleet(rows, "name").map((r) => r.tenantId)).toEqual(["2", "1"]);
    expect(sortFleet(rows, "created").map((r) => r.tenantId)).toEqual(["2", "1"]);
  });
});

describe.skipIf(!runnable)("fleet + audit queries (local db)", () => {
  let db: typeof import("@wezesha/db");
  let fleet: typeof import("../lib/admin/fleet");
  let audit: typeof import("../lib/admin/audit");
  let tenantAId: string;
  let tenantBId: string;
  let userId: string;
  const now = Date.now();

  beforeAll(async () => {
    db = await import("@wezesha/db");
    fleet = await import("../lib/admin/fleet");
    audit = await import("../lib/admin/audit");

    await db.prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await db.prismaService.user.deleteMany({ where: { email: "admin-fleet@example.test" } });

    const a = await db.prismaService.tenant.create({
      data: { name: "Admin Fleet A", slug: SLUG_A },
    });
    tenantAId = a.id;
    const b = await db.prismaService.tenant.create({
      data: { name: "Admin Fleet B", slug: SLUG_B },
    });
    tenantBId = b.id;

    userId = crypto.randomUUID();
    await db.prismaService.user.create({
      data: { id: userId, name: "Fleet Member", email: "admin-fleet@example.test" },
    });
    await db.prismaService.membership.create({
      data: { userId, tenantId: tenantAId, role: "OWNER", displayName: "Fleet Owner" },
    });

    await db.prismaService.shopifyConnection.create({
      data: {
        tenantId: tenantAId,
        shopDomain: "admin-fleet-a.myshopify.com",
        accessToken: "ciphertext",
        scopes: "read_products",
      },
    });
    // products fresh (1h), orders stale (30h), inventory never synced.
    await db.prismaService.ingestCursor.createMany({
      data: [
        { tenantId: tenantAId, source: "shopify", resource: "products", cursor: new Date(now - HOUR) },
        { tenantId: tenantAId, source: "shopify", resource: "orders", cursor: new Date(now - 30 * HOUR) },
      ],
    });
    await db.prismaService.product.create({
      data: { tenantId: tenantAId, sku: "FLEET-1", title: "Fleet Product" },
    });
    await db.prismaService.notification.createMany({
      data: [
        { tenantId: tenantAId, kind: "sync_failed", title: "Sync failed" },
        { tenantId: tenantAId, kind: "sync_failed", title: "Sync failed again" },
        { tenantId: tenantAId, kind: "sync_failed", title: "Read one", readAt: new Date() },
      ],
    });
  }, 30_000);

  afterAll(async () => {
    await db.prismaService.auditEvent.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    });
    await db.prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await db.prismaService.user.deleteMany({ where: { email: "admin-fleet@example.test" } });
    await db.prismaService.$disconnect();
  });

  it("shapes a connected tenant's row: counts, cursor ages, worst staleness", async () => {
    const rows = await fleet.getFleet(now);
    const rowA = rows.find((r) => r.tenantId === tenantAId);
    expect(rowA).toBeTruthy();
    expect(rowA).toMatchObject({
      name: "Admin Fleet A",
      slug: SLUG_A,
      memberCount: 1,
      productCount: 1,
      connection: { state: "live", shopDomain: "admin-fleet-a.myshopify.com" },
      openNotifications: 2, // the read one does not count
      lastForecastRunAt: null,
    });
    expect(rowA!.lastSync.products?.getTime()).toBe(now - HOUR);
    expect(rowA!.lastSync.orders?.getTime()).toBe(now - 30 * HOUR);
    expect(rowA!.lastSync.inventory).toBeNull();
    // inventory has never synced → worst staleness is Infinity.
    expect(rowA!.stalenessMs).toBe(Infinity);
    // The stale flag line: orders at 30h is past the 24h threshold.
    expect(now - rowA!.lastSync.orders!.getTime()).toBeGreaterThan(STALE_AFTER_MS);
  });

  it("shapes a bare tenant's row: no connection, nothing to be stale", async () => {
    const rows = await fleet.getFleet(now);
    const rowB = rows.find((r) => r.tenantId === tenantBId);
    expect(rowB).toMatchObject({
      memberCount: 0,
      productCount: 0,
      connection: { state: "none", shopDomain: null },
      stalenessMs: null,
      openNotifications: 0,
    });
  });

  it("getTenantDetail returns the roster with emails; null for unknown ids", async () => {
    const detail = await fleet.getTenantDetail(tenantAId);
    expect(detail?.tenant.slug).toBe(SLUG_A);
    expect(detail?.members).toHaveLength(1);
    expect(detail?.members[0]).toMatchObject({
      role: "OWNER",
      displayName: "Fleet Owner",
      email: "admin-fleet@example.test",
    });
    expect(await fleet.getTenantDetail("no-such-tenant")).toBeNull();
  });

  it("listAuditEvents filters by tenant and action, and paginates by cursor", async () => {
    const admin = { userId: "admin-1", email: "ops@example.test", name: "Ops" };
    await audit.recordAdminEvent({ tenantId: tenantAId, action: "impersonation_start", admin });
    await audit.recordAdminEvent({ tenantId: tenantAId, action: "impersonation_end", admin });
    await audit.recordAdminEvent({ tenantId: tenantBId, action: "admin_sync_trigger", admin });

    const forA = await audit.listAuditEvents({ tenantId: tenantAId });
    expect(forA.rows.map((r) => r.action).sort()).toEqual([
      "impersonation_end",
      "impersonation_start",
    ]);
    expect(forA.rows.every((r) => r.tenantName === "Admin Fleet A")).toBe(true);

    const starts = await audit.listAuditEvents({ tenantId: tenantAId, action: "impersonation_start" });
    expect(starts.rows).toHaveLength(1);
    expect(starts.rows[0]).toMatchObject({
      entity: "AdminSession",
      entityId: tenantAId,
      actorName: "Ops",
    });
    expect(starts.rows[0]!.meta).toMatchObject({ adminEmail: "ops@example.test" });

    // Page size 1: newest first, cursor walks to the older row.
    const page1 = await audit.listAuditEvents({ tenantId: tenantAId, limit: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await audit.listAuditEvents({
      tenantId: tenantAId,
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]!.id).not.toBe(page1.rows[0]!.id);
  });
});
