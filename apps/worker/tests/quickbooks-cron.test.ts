import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The QuickBooks reconcile cron: who it dispatches to, and when it rings the
 * bell.
 *
 * `reconcilePurchaseOrders` is mocked here on purpose — its own behaviour is
 * covered against a real database in apps/web. What is asserted here is the
 * cron's judgement: only connected workspaces get a job, a clean run says
 * nothing, and a repeat within the window does not ring twice.
 */

const reconcile = vi.fn();
vi.mock("@wezesha/quickbooks", () => ({
  reconcilePurchaseOrders: (...args: unknown[]) => reconcile(...args),
}));

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG_CONNECTED = "qb-cron-connected";
const SLUG_BARE = "qb-cron-bare";

describe.skipIf(!runnable)("the QuickBooks reconcile cron (real db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let cron: typeof import("../src/quickbooks-cron");
  let connectedTenantId: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({
      where: { slug: { in: [SLUG_CONNECTED, SLUG_BARE] } },
    });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    cron = await import("../src/quickbooks-cron");
    reconcile.mockReset();

    await prismaService.tenant.deleteMany({
      where: { slug: { in: [SLUG_CONNECTED, SLUG_BARE] } },
    });
    const connected = await prismaService.tenant.create({
      data: { name: "Connected", slug: SLUG_CONNECTED, currency: "KES" },
    });
    connectedTenantId = connected.id;
    await prismaService.tenant.create({
      data: { name: "Bare", slug: SLUG_BARE, currency: "KES" },
    });
    await prismaService.quickBooksConnection.create({
      data: {
        tenantId: connected.id,
        realmId: `realm-${connected.id}`,
        accessToken: "x",
        refreshToken: "y",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        scopes: "com.intuit.quickbooks.accounting",
      },
    });
  });

  const notifications = (tenantId: string) =>
    prismaService.notification.findMany({ where: { tenantId }, select: { kind: true } });

  it("dispatches only to workspaces with a live connection", async () => {
    const added: Array<{ data: { tenantId?: string } }> = [];
    const queue = { addBulk: async (jobs: typeof added) => added.push(...jobs) };

    const count = await cron.dispatchQuickBooksReconciles(queue as never);

    expect(count).toBe(1);
    expect(added.map((j) => j.data.tenantId)).toEqual([connectedTenantId]);
  });

  it("skips a workspace whose connection is paused", async () => {
    await prismaService.quickBooksConnection.updateMany({
      where: { tenantId: connectedTenantId },
      data: { syncPausedAt: new Date() },
    });
    const queue = { addBulk: async () => {} };
    expect(await cron.dispatchQuickBooksReconciles(queue as never)).toBe(0);
  });

  it("says nothing when everything matched", async () => {
    reconcile.mockResolvedValue({ ok: true, confirmed: 3, suggested: 0, phantoms: 0, external: [] });

    await cron.reconcileTenantBooks(connectedTenantId);

    // A bell that rings on success is a bell people stop reading.
    expect(await notifications(connectedTenantId)).toEqual([]);
  });

  it("raises one notice for orders missing from the books", async () => {
    reconcile.mockResolvedValue({ ok: true, confirmed: 0, suggested: 0, phantoms: 2, external: [] });

    await cron.reconcileTenantBooks(connectedTenantId);

    expect((await notifications(connectedTenantId)).map((n) => n.kind)).toEqual([
      "qb_orders_missing_from_books",
    ]);
  });

  it("raises a separate notice for orders raised outside this system", async () => {
    reconcile.mockResolvedValue({
      ok: true,
      confirmed: 0,
      suggested: 0,
      phantoms: 0,
      external: [{ id: "qb-9", docNumber: "QB-900", totalAmt: 500, txnDate: null, vendorName: null }],
    });

    await cron.reconcileTenantBooks(connectedTenantId);

    expect((await notifications(connectedTenantId)).map((n) => n.kind)).toEqual([
      "qb_orders_raised_elsewhere",
    ]);
  });

  it("does not ring twice for the same problem inside the window", async () => {
    reconcile.mockResolvedValue({ ok: true, confirmed: 0, suggested: 0, phantoms: 2, external: [] });

    await cron.reconcileTenantBooks(connectedTenantId);
    await cron.reconcileTenantBooks(connectedTenantId);

    expect(await notifications(connectedTenantId)).toHaveLength(1);
  });

  it("stays quiet when the connection cannot be used", async () => {
    reconcile.mockResolvedValue({ ok: false, reason: "not_connected" });

    const result = await cron.reconcileTenantBooks(connectedTenantId);

    expect(result).toBeNull();
    expect(await notifications(connectedTenantId)).toEqual([]);
  });
});
