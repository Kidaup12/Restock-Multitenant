import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Plan-limit cron against the local database: over-limit detection, the grace
 * anchor lifecycle (set on first-over, cleared on recovery), and the weekly
 * warning dedup. Uses its own fixture tenant with a tiny planLimits override —
 * never a seeded dev tenant. Skips without local infrastructure.
 */

const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

const SLUG = "limits-cron-test";
const DAY_MS = 86_400_000;

describe.skipIf(!localDb)("limits cron (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let limits: typeof import("../src/limits-cron");
  let tenantId: string;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    limits = await import("../src/limits-cron");

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: {
        name: "Limits Cron Test",
        slug: SLUG,
        plan: "starter",
        // Tiny override so two products trip the limit without bulk fixtures.
        planLimits: { maxProducts: 1 },
      },
    });
    tenantId = tenant.id;

    await prismaService.product.createMany({
      data: [
        { tenantId, sku: "LIM-1", title: "Shea Butter 100g" },
        { tenantId, sku: "LIM-2", title: "Marula Oil 30ml" },
      ],
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("detects over-limit usage, starts the grace clock, and warns once", async () => {
    const result = await limits.checkTenantLimits(tenantId);
    expect(result).not.toBeNull();
    expect(result!.state.products).toMatchObject({ used: 2, max: 1, over: true });
    expect(result!.state.members.over).toBe(false);
    expect(result!.state.anyOver).toBe(true);
    expect(result!.state.graceLeftDays).toBe(7);
    expect(result!.warned).toBe(true);

    const config = await prismaService.tenantConfig.findUnique({ where: { tenantId } });
    expect(config?.limitsExceededAt).toBeInstanceOf(Date);

    const notifications = await prismaService.notification.findMany({
      where: { tenantId, kind: "limit_warning" },
    });
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.body).toContain("products (2 of 1)");
  });

  it("dedupes the warning to one per week", async () => {
    const again = await limits.checkTenantLimits(tenantId);
    expect(again!.state.anyOver).toBe(true);
    expect(again!.warned).toBe(false);

    const notifications = await prismaService.notification.count({
      where: { tenantId, kind: "limit_warning" },
    });
    expect(notifications).toBe(1);
  });

  it("counts down grace from the first-over timestamp, not from today", async () => {
    // Backdate the anchor three days: 7-day grace leaves 4.
    const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS);
    await prismaService.tenantConfig.updateMany({
      where: { tenantId },
      data: { limitsExceededAt: threeDaysAgo },
    });

    const result = await limits.checkTenantLimits(tenantId);
    expect(result!.state.graceLeftDays).toBe(4);

    // Grace fully elapsed → 0 (and the body says the grace period ended).
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS);
    await prismaService.tenantConfig.updateMany({
      where: { tenantId },
      data: { limitsExceededAt: eightDaysAgo },
    });
    const expired = await limits.checkTenantLimits(tenantId);
    expect(expired!.state.graceLeftDays).toBe(0);
    expect(limits.limitWarningBody(expired!.state)).toContain("grace period has ended");
  });

  it("clears the grace anchor when usage drops back under the limit", async () => {
    await prismaService.product.deleteMany({ where: { tenantId, sku: "LIM-2" } });

    const result = await limits.checkTenantLimits(tenantId);
    expect(result!.state.products.over).toBe(false);
    expect(result!.state.anyOver).toBe(false);
    expect(result!.state.graceLeftDays).toBeNull();
    expect(result!.warned).toBe(false);

    const config = await prismaService.tenantConfig.findUnique({ where: { tenantId } });
    expect(config?.limitsExceededAt).toBeNull();
  });

  it("returns null for a tenant that no longer exists", async () => {
    expect(await limits.checkTenantLimits("gone-tenant-id")).toBeNull();
  });
});
