import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Billing period + status from the operator console (there is no self-serve
 * billing yet). The gate and step-up are proven on their own suites and stubbed
 * open here; what this holds is the part that is new — the period arithmetic, the
 * status enum, the far-past guard, and what reaches the ledger.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const ADMIN = {
  userId: "admin-billing-user",
  email: "billing-admin@example.test",
  name: "Billing Admin",
  sessionId: "sess-test",
  viaFallback: false,
};

vi.mock("@/lib/admin/gate", () => ({ requireAdmin: async () => ADMIN }));
vi.mock("@/lib/admin/step-up", () => ({ hasStepUp: async () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prismaService } from "@wezesha/db";
import { setTenantBilling } from "@/app/admin/actions";

const SLUG = "admin-billing-tenant";
const DAY_MS = 86_400_000;

function form(entries: Record<string, string>): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(entries)) body.set(k, v);
  return body;
}

describe.skipIf(!runnable)("admin billing control (local db)", () => {
  let tenantId = "";

  beforeAll(async () => {
    await cleanup();
    const tenant = await prismaService.tenant.create({
      data: { name: "Admin Billing Tenant", slug: SLUG, plan: "growth" },
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

  const billingNow = () =>
    prismaService.tenant.findUnique({
      where: { id: tenantId },
      select: { planPeriodEnd: true, planStatus: true, billingNote: true },
    });

  it("extends by 30 days from now on a workspace with no period, and records it", async () => {
    const result = await setTenantBilling(
      form({ tenantId, status: "active", periodMode: "extend", note: "invoiced offline" })
    );
    expect(result.ok).toBe(true);
    const row = await billingNow();
    expect(row?.planStatus).toBe("active");
    expect(row?.billingNote).toBe("invoiced offline");
    // ~30 days out from now (allow a minute of slack for the test run).
    const expected = Date.now() + 30 * DAY_MS;
    expect(Math.abs((row!.planPeriodEnd!.getTime()) - expected)).toBeLessThan(60_000);

    const events = await prismaService.auditEvent.findMany({
      where: { tenantId, action: "billing_adjusted" },
    });
    expect(events.length).toBe(1);
    expect(events[0]!.entity).toBe("Tenant");
    expect(events[0]!.meta).toMatchObject({ status: { from: null, to: "active" } });
  });

  it("sets an explicit UTC date", async () => {
    const result = await setTenantBilling(
      form({ tenantId, status: "trialing", periodMode: "date", periodEnd: "2027-01-15", note: "" })
    );
    expect(result.ok).toBe(true);
    const row = await billingNow();
    expect(row?.planStatus).toBe("trialing");
    expect(row?.planPeriodEnd?.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    // Empty note clears the memo.
    expect(row?.billingNote).toBeNull();
  });

  it("refuses an unknown status and a far-past explicit date, writing nothing", async () => {
    const before = await billingNow();
    expect(await setTenantBilling(form({ tenantId, status: "deadbeat", periodMode: "keep" }))).toEqual({
      ok: false,
      error: "Unknown billing status.",
    });
    expect(
      await setTenantBilling(form({ tenantId, status: "active", periodMode: "date", periodEnd: "1990-01-01" }))
    ).toEqual({ ok: false, error: "That date is too far in the past — check it." });
    const after = await billingNow();
    expect(after?.planStatus).toBe(before?.planStatus);
    expect(after?.planPeriodEnd?.toISOString()).toBe(before?.planPeriodEnd?.toISOString());
  });

  it("clears the period", async () => {
    const result = await setTenantBilling(
      form({ tenantId, status: "canceled", periodMode: "clear", note: "" })
    );
    expect(result).toMatchObject({ ok: true, status: "canceled", periodEnd: null });
    const row = await billingNow();
    expect(row?.planPeriodEnd).toBeNull();
    expect(row?.planStatus).toBe("canceled");
  });

  it("404s on a workspace that does not exist", async () => {
    await expect(
      setTenantBilling(form({ tenantId: "no-such-id", status: "active", periodMode: "extend" }))
    ).rejects.toThrow();
  });
});
