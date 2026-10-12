import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Billing enforcement cron against the local database: a lapsed period past the
 * grace window softens to past_due (soft — no lockout), while a live period, a
 * within-grace lapse, a workspace with no period, and one already past_due or
 * canceled are all left untouched. Uses its own fixture tenant. Skips without
 * local infrastructure.
 */

const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

const SLUG = "billing-cron-test";
const DAY_MS = 86_400_000;

describe.skipIf(!localDb)("billing cron (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let billing: typeof import("../src/billing-cron");
  let tenantId: string;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    billing = await import("../src/billing-cron");

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Billing Cron Test", slug: SLUG, plan: "growth", planStatus: "active" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  const setPeriod = (end: Date | null, status: string) =>
    prismaService.tenant.update({
      where: { id: tenantId },
      data: { planPeriodEnd: end, planStatus: status },
    });

  const statusNow = async () =>
    (await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { planStatus: true } }))
      ?.planStatus;

  it("leaves a live period untouched", async () => {
    await setPeriod(new Date(Date.now() + 10 * DAY_MS), "active");
    const result = await billing.checkTenantBilling(tenantId);
    expect(result).toEqual({ softened: false, status: "active" });
    expect(await statusNow()).toBe("active");
  });

  it("leaves a lapse still inside the grace window untouched", async () => {
    // Lapsed 3 days ago; grace is 7, so nothing happens yet.
    await setPeriod(new Date(Date.now() - 3 * DAY_MS), "active");
    const result = await billing.checkTenantBilling(tenantId);
    expect(result).toEqual({ softened: false, status: "active" });
    expect(await statusNow()).toBe("active");
  });

  it("softens to past_due once the lapse is past the grace window", async () => {
    await setPeriod(new Date(Date.now() - (billing.BILLING_GRACE_DAYS + 2) * DAY_MS), "active");
    const result = await billing.checkTenantBilling(tenantId);
    expect(result).toEqual({ softened: true, status: "past_due" });
    expect(await statusNow()).toBe("past_due");
  });

  it("is idempotent: a workspace already past_due is not re-softened", async () => {
    // Still long-lapsed, but status is now past_due — nothing to re-decide.
    const result = await billing.checkTenantBilling(tenantId);
    expect(result).toEqual({ softened: false, status: "past_due" });
    expect(await statusNow()).toBe("past_due");
  });

  it("leaves a canceled workspace alone even with a long-lapsed period", async () => {
    await setPeriod(new Date(Date.now() - 90 * DAY_MS), "canceled");
    const result = await billing.checkTenantBilling(tenantId);
    expect(result).toEqual({ softened: false, status: "canceled" });
    expect(await statusNow()).toBe("canceled");
  });

  it("leaves a workspace with no period kept alone", async () => {
    await setPeriod(null, "active");
    const result = await billing.checkTenantBilling(tenantId);
    expect(result).toEqual({ softened: false, status: "active" });
    expect(await statusNow()).toBe("active");
  });

  it("returns null for a tenant that no longer exists", async () => {
    expect(await billing.checkTenantBilling("gone-tenant-id")).toBeNull();
  });
});
