import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Tier control from the admin console.
 *
 * `Tenant.plan` previously had no writer anywhere in the product: it was set
 * once at provisioning and never again, so moving a customer off the entry tier
 * meant a hand-written UPDATE against production — while Insights, Transfers,
 * the budget planner and supplier PO email all sit behind it.
 *
 * The allow-list gate itself is covered by admin-gate.test.ts against the real
 * handler; it is stubbed here so the action is callable outside a request
 * scope. What these tests hold is the part that is new: what reaches the column,
 * and what reaches the ledger.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const ADMIN = {
  userId: "admin-plan-user",
  email: "plan-admin@example.test",
  name: "Plan Admin",
  viaFallback: false,
};

vi.mock("@/lib/admin/gate", () => ({
  requireAdmin: async () => ADMIN,
}));
// The gate and the step-up grant are each proven on their own suite; here they
// are held open so the action under test is the only thing being measured.
vi.mock("@/lib/admin/step-up", () => ({ hasStepUp: async () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prismaService } from "@wezesha/db";
import { setTenantPlan } from "@/app/admin/actions";

const SLUG = "admin-plan-tenant";

function form(tenantId: string, plan: string): FormData {
  const body = new FormData();
  body.set("tenantId", tenantId);
  body.set("plan", plan);
  return body;
}

describe.skipIf(!runnable)("admin tier control (local db)", () => {
  let tenantId = "";

  beforeAll(async () => {
    await cleanup();
    const tenant = await prismaService.tenant.create({
      data: { name: "Admin Plan Tenant", slug: SLUG, plan: "starter" },
    });
    tenantId = tenant.id;
  }, 60_000);

  afterAll(cleanup);

  async function cleanup() {
    const existing = await prismaService.tenant.findUnique({ where: { slug: SLUG } });
    if (existing) {
      await prismaService.auditEvent.deleteMany({ where: { tenantId: existing.id } });
      await prismaService.tenant.delete({ where: { id: existing.id } });
    }
  }

  const planNow = async () =>
    (await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }))?.plan;

  const planEvents = () =>
    prismaService.auditEvent.findMany({
      where: { tenantId, action: "plan_changed" },
      orderBy: { createdAt: "asc" },
    });

  it("moves the workspace up a tier and records who did it", async () => {
    const result = await setTenantPlan(form(tenantId, "growth"));
    expect(result).toEqual({ ok: true, plan: "growth" });
    expect(await planNow()).toBe("growth");

    const events = await planEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    // The ledger has to answer "who changed what, from what" without a join.
    expect(event!.entity).toBe("Tenant");
    expect(event!.actorUserId).toBe(ADMIN.userId);
    expect(event!.meta).toMatchObject({ from: "starter", to: "growth", adminEmail: ADMIN.email });
  });

  it("stores the canonical key when given the display spelling", async () => {
    // The tier aliases accept "Essential"; the column must not.
    const result = await setTenantPlan(form(tenantId, "Essential"));
    expect(result).toEqual({ ok: true, plan: "starter" });
    expect(await planNow()).toBe("starter");
  });

  it("refuses a tier that does not exist, and writes nothing", async () => {
    const before = await planNow();
    const countBefore = (await planEvents()).length;

    for (const bogus of ["enterprise", "", "free; drop table"]) {
      expect(await setTenantPlan(form(tenantId, bogus))).toEqual({
        ok: false,
        error: "Unknown plan.",
      });
    }

    expect(await planNow()).toBe(before);
    expect(await planEvents()).toHaveLength(countBefore);
  });

  it("treats re-selecting the current tier as a no-op rather than a change", async () => {
    const current = await planNow();
    const countBefore = (await planEvents()).length;

    const result = await setTenantPlan(form(tenantId, current!));

    expect(result).toEqual({ ok: true, plan: current });
    // No ledger row: an audit trail that records non-events is harder to read
    // when someone is trying to find the change that mattered.
    expect(await planEvents()).toHaveLength(countBefore);
  });

  it("404s on a workspace that does not exist instead of creating one", async () => {
    // notFound() throws; the id is caller-supplied here, so this is the guard
    // that keeps it from being taken on trust.
    await expect(setTenantPlan(form("no-such-tenant-id", "growth"))).rejects.toThrow();
    await expect(setTenantPlan(form("", "growth"))).rejects.toThrow();
  });
});
