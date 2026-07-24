import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Sales-gap cron against the local database: a branch silent on a day its
 * sibling sold raises exactly one bell, a dismissed closure suppresses it, and
 * the same gap never double-notifies. Uses its own fixture tenant. Skips without
 * a local database.
 */

const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const SLUG = "pos-gap-cron-test";
const NOW = new Date("2026-07-20T08:00:00Z"); // Nairobi day 2026-07-20
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe.skipIf(!localDb)("sales-gap cron (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let gap: typeof import("../src/pos-gap-cron");
  let tenantId: string;
  let branchA: string;
  let branchB: string;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    gap = await import("../src/pos-gap-cron");

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Gap Cron Test", slug: SLUG, timezone: "Africa/Nairobi" },
    });
    tenantId = tenant.id;

    const a = await prismaService.location.create({
      data: { tenantId, name: "Kilimani", locationType: "branch", roleStatus: "confirmed" },
    });
    const b = await prismaService.location.create({
      data: { tenantId, name: "Westlands", locationType: "branch", roleStatus: "confirmed" },
    });
    branchA = a.id;
    branchB = b.id;

    const p = await prismaService.product.create({ data: { tenantId, sku: "P1", title: "Product One" } });
    const q = await prismaService.product.create({ data: { tenantId, sku: "Q1", title: "Product Two" } });

    // 07-18: both branches sold. 07-19: only Kilimani sold → Westlands is a gap.
    await prismaService.salesHistory.createMany({
      data: [
        { tenantId, productId: p.id, date: day("2026-07-18"), quantity: 5, revenueKes: 500, channel: "pos", locationId: branchA },
        { tenantId, productId: p.id, date: day("2026-07-19"), quantity: 3, revenueKes: 300, channel: "pos", locationId: branchA },
        { tenantId, productId: q.id, date: day("2026-07-18"), quantity: 2, revenueKes: 200, channel: "pos", locationId: branchB },
      ],
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.notification.deleteMany({ where: { tenantId, kind: "sales_gap" } });
    await prismaService.locationClosure.deleteMany({ where: { tenantId } });
  });

  it("flags the silent branch and raises one bell", async () => {
    const result = await gap.checkTenantSalesGaps(tenantId, null, NOW);
    expect(result).not.toBeNull();
    expect(result!.gaps).toEqual([{ locationId: branchB, dayKey: "2026-07-19" }]);
    expect(result!.notified).toBe(1);

    const notes = await prismaService.notification.findMany({ where: { tenantId, kind: "sales_gap" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("Westlands recorded zero sales on Sun 19 Jul");
  });

  it("does not double-notify the same gap on a second run", async () => {
    await gap.checkTenantSalesGaps(tenantId, null, NOW);
    const again = await gap.checkTenantSalesGaps(tenantId, null, NOW);
    expect(again!.gaps).toHaveLength(1);
    expect(again!.notified).toBe(0);
    expect(await prismaService.notification.count({ where: { tenantId, kind: "sales_gap" } })).toBe(1);
  });

  it("suppresses a gap that was dismissed as a closure", async () => {
    await prismaService.locationClosure.create({
      data: { tenantId, locationId: branchB, date: day("2026-07-19"), reason: "closed" },
    });
    const result = await gap.checkTenantSalesGaps(tenantId, null, NOW);
    expect(result!.gaps).toEqual([]);
    expect(result!.notified).toBe(0);
  });

  it("returns null for a tenant that no longer exists", async () => {
    expect(await gap.checkTenantSalesGaps("gone-tenant-id", null, NOW)).toBeNull();
  });
});
