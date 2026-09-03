import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Plan-screen server actions against the local database. The focus here is the
 * plan gate on planBudget: the budget allocator is a Growth feature, so a
 * Starter tenant is refused server-side even if the UI lock were bypassed, while
 * a Growth tenant clears the gate. Session + revalidation are stubbed; the
 * tenant plan is read from the real (RLS-scoped) database. Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | { tenantId: string; displayName: string | null; role: string; permissions: unknown }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaService } from "@wezesha/db";
import { planBudget } from "../app/(shell)/plan/actions";

const SLUGS = ["plan-gate-starter", "plan-gate-growth"];
const PLAN_LOCKED = "Budget planner is on the Growth plan.";

describe.skipIf(!runnable)("planBudget plan gate (local db)", () => {
  let starterTenant: string;
  let growthTenant: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    starterTenant = (
      await prismaService.tenant.create({ data: { name: "Gate Starter", slug: SLUGS[0]!, plan: "starter" } })
    ).id;
    growthTenant = (
      await prismaService.tenant.create({ data: { name: "Gate Growth", slug: SLUGS[1]!, plan: "growth" } })
    ).id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [starterTenant, growthTenant] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string) {
    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner", role: "OWNER", permissions: null };
  }

  it("clears the plan gate on Starter now that budgeting is an entry-tier feature", async () => {
    // Budgeting moved to Starter: planning against what you can spend is core to
    // what the product does, not an upsell. A Starter tenant now falls through
    // the plan lock to the next check rather than being refused at it.
    actAs(starterTenant);
    const res = await planBudget({ budgetKes: 5000 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error, "budgeting is still gated behind the plan tier").not.toBe(PLAN_LOCKED);
      expect(res.error).toBe("Run a forecast first — there's nothing to plan yet.");
    }
  });

  it("also clears it for a Growth tenant", async () => {
    actAs(growthTenant);
    const res = await planBudget({ budgetKes: 5000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toBe(PLAN_LOCKED);
  });

  it("refuses without a workspace regardless of plan", async () => {
    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = null;
    expect(await planBudget({ budgetKes: 5000 })).toEqual({ ok: false, error: "You're not in a workspace." });
  });
});
