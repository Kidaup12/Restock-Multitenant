import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Removing a store must actually delete the row, and only this workspace's.
 *
 * Disconnect is a pause: it stamps uninstalledAt and keeps the row and token so
 * Reconnect can reuse them. Nothing deleted the row, and `shopDomain` is unique
 * across the whole database — so a shop stayed claimed by its workspace
 * forever. On production a merchant had disconnected AND cleared their
 * credentials and the store was still listed, with no way to shift it.
 *
 * Read back from the database, not off a result object: the action returning
 * `ok` proves one code path, not that the row is gone.
 */

let actor: { userId: string; tenantId: string; role: string } | null = null;

vi.mock("@/lib/shopify/membership", () => ({
  tenantActor: async () => actor,
  canManageConnections: (a: { role: string }) => a.role === "OWNER" || a.role === "ADMIN",
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

describe.skipIf(!runnable)("removing a Shopify store (seeded local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let removeShopifyStore: typeof import("../app/(shell)/settings/connections/actions").removeShopifyStore;
  let tenants: import("../../../packages/db/tests/seed-two-tenants").SeededTenants;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    ({ removeShopifyStore } = await import("../app/(shell)/settings/connections/actions"));
    const { seedTwoTenants } = await import("../../../packages/db/tests/seed-two-tenants");
    tenants = await seedTwoTenants();
  }, 120_000);

  // The fixture's rows outlive this file otherwise, and at least one other
  // suite asserts on an UNSCOPED read (every workspace's owner priors), so
  // leftovers here surface as unrelated failures over there.
  afterAll(async () => {
    const { SLUG_A, SLUG_B } = await import("../../../packages/db/tests/seed-two-tenants");
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  });

  it("deletes this workspace's connection and leaves the other workspace's alone", async () => {
    const before = await prismaService.shopifyConnection.count();
    expect(before, "the fixture seeds a connection for each tenant").toBeGreaterThanOrEqual(2);

    actor = { userId: "u", tenantId: tenants.a.id, role: "OWNER" };
    const res = await removeShopifyStore();
    expect(res.ok, res.ok ? "" : res.error).toBe(true);

    const mine = await prismaService.shopifyConnection.count({ where: { tenantId: tenants.a.id } });
    expect(mine, "the row is still there, so the store cannot be replaced").toBe(0);

    // The control that matters on a multi-tenant table: deleting A must not
    // touch B. A `deleteMany` with a mistaken scope passes every check above.
    const theirs = await prismaService.shopifyConnection.count({ where: { tenantId: tenants.b.id } });
    expect(theirs, "removing one workspace's store deleted another's").toBe(1);
  });

  it("says so plainly when there is no store to remove", async () => {
    actor = { userId: "u", tenantId: tenants.a.id, role: "OWNER" };
    const res = await removeShopifyStore();
    expect(res.ok).toBe(false);
  });

  it("is refused for someone who cannot manage connections", async () => {
    actor = { userId: "u", tenantId: tenants.b.id, role: "MEMBER" };
    const res = await removeShopifyStore();
    expect(res.ok).toBe(false);
    const theirs = await prismaService.shopifyConnection.count({ where: { tenantId: tenants.b.id } });
    expect(theirs, "a member removed a store").toBe(1);
  });
});
