import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The impersonated workspace summary reads through the SAME lib/data modules
 * as the tenant's own pages, on the RLS-enforced tenant client — so an admin
 * viewing tenant A must see exactly A's numbers even with tenant B's data
 * sitting in the same tables. Real database; skips without a local service
 * connection.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const SLUG_A = "admin-ws-a";
const SLUG_B = "admin-ws-b";
const DAY = 86_400_000;

describe.skipIf(!runnable)("impersonated summary reads (RLS-scoped)", () => {
  let db: typeof import("@wezesha/db");
  let today: typeof import("../lib/data/today");
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    db = await import("@wezesha/db");
    today = await import("../lib/data/today");

    await db.prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });

    const mkTenant = async (slug: string, name: string, revenue: number) => {
      const tenant = await db.prismaService.tenant.create({ data: { name, slug } });
      const product = await db.prismaService.product.create({
        data: { tenantId: tenant.id, sku: `${slug}-SKU`, title: `${name} Product`, costKes: 100 },
      });
      await db.prismaService.salesHistory.create({
        data: {
          tenantId: tenant.id,
          productId: product.id,
          date: new Date(Date.now() - 2 * DAY),
          quantity: 1,
          revenueKes: revenue,
        },
      });
      const location = await db.prismaService.location.create({
        data: { tenantId: tenant.id, name: `${name} Shop`, isPrimary: true },
      });
      await db.prismaService.inventoryLevel.create({
        data: { tenantId: tenant.id, locationId: location.id, productId: product.id, onHand: 5 },
      });
      return tenant.id;
    };

    tenantAId = await mkTenant(SLUG_A, "Admin WS A", 1111);
    tenantBId = await mkTenant(SLUG_B, "Admin WS B", 2222);
  }, 30_000);

  afterAll(async () => {
    await db.prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await db.prismaService.$disconnect();
  });

  it("tenant A's summary carries only A's revenue and catalogue", async () => {
    const metrics = await today.getTodayMetrics(tenantAId, { canViewCosts: true });
    expect(metrics.revenue30dKes).toBe(1111);
    expect(metrics.trackedProducts).toBe(1);
    expect(metrics.stockedOutProducts).toBe(0);
  });

  it("tenant B's summary is B's alone — same query, other GUC", async () => {
    const metrics = await today.getTodayMetrics(tenantBId, { canViewCosts: true });
    expect(metrics.revenue30dKes).toBe(2222);
    expect(metrics.trackedProducts).toBe(1);
  });

  it("a junk tenant id sees nothing (RLS fail-closed), not everything", async () => {
    const metrics = await today.getTodayMetrics("no-such-tenant", { canViewCosts: true });
    expect(metrics.revenue30dKes).toBe(0);
    expect(metrics.trackedProducts).toBe(0);
  });
});
