import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRACE_DAYS, prismaService } from "@wezesha/db";
import { checkLimit, evaluateLimits } from "../lib/limits/evaluate";

/**
 * Web-side plan-limit reads against the local database (RLS tenant client).
 * The worker cron owns the grace anchor; here we prove the read path reports
 * usage, overage, and grace correctly — including allowed=false once grace
 * has run out. Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "limits-web-test";
const DAY_MS = 86_400_000;

describe.skipIf(!runnable)("evaluateLimits / checkLimit (local db)", () => {
  let tenantId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: {
        name: "Limits Web Test",
        slug: SLUG,
        plan: "starter",
        planLimits: { maxProducts: 1 },
      },
    });
    tenantId = tenant.id;
    await prismaService.product.createMany({
      data: [
        { tenantId, sku: "LW-1", title: "Cocoa Butter 100g" },
        { tenantId, sku: "LW-2", title: "Argan Oil 30ml" },
        // Inactive products don't count against the plan.
        { tenantId, sku: "LW-3", title: "Retired SKU", active: false },
      ],
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("reports per-dimension usage with the override applied", async () => {
    const state = await evaluateLimits(tenantId);
    expect(state.products).toMatchObject({ used: 2, max: 1, over: true });
    expect(state.members).toMatchObject({ used: 0, max: 3, over: false });
    expect(state.orders30d.over).toBe(false);
    expect(state.anyOver).toBe(true);
    // No anchor yet (the cron hasn't run): full grace reported.
    expect(state.graceLeftDays).toBe(GRACE_DAYS);
  });

  it("checkLimit warns but allows while grace remains", async () => {
    const check = await checkLimit(tenantId, "add_product");
    expect(check.over).toBe(true);
    expect(check.allowed).toBe(true);
    expect(check.message).toContain("grace");
  });

  it("checkLimit disallows once the grace window has fully elapsed", async () => {
    await prismaService.tenantConfig.upsert({
      where: { tenantId },
      create: { tenantId, limitsExceededAt: new Date(Date.now() - (GRACE_DAYS + 1) * DAY_MS) },
      update: { limitsExceededAt: new Date(Date.now() - (GRACE_DAYS + 1) * DAY_MS) },
    });
    const check = await checkLimit(tenantId, "add_product");
    expect(check.over).toBe(true);
    expect(check.graceLeftDays).toBe(0);
    expect(check.allowed).toBe(false);
  });

  it("an in-plan dimension is unaffected by another's overage", async () => {
    const check = await checkLimit(tenantId, "invite_member");
    expect(check).toEqual({ allowed: true, over: false, graceLeftDays: null, message: null });
  });
});
