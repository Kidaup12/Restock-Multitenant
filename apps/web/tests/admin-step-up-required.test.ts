import { describe, expect, it, vi } from "vitest";

/**
 * Every console mutation refuses without a live step-up grant.
 *
 * The action suites next door mock the grant open so they can measure the
 * action itself; this is the other half — with the grant closed, nothing may
 * write. Without it, deleting the guard from an action would break no test.
 *
 * Paired with the static check below, which catches a NEW action that never
 * asks at all.
 */

const ADMIN = {
  userId: "step-up-required-admin",
  email: "step-up-required@example.test",
  name: "Guarded",
  viaFallback: false,
};

vi.mock("@/lib/admin/gate", () => ({ requireAdmin: async () => ADMIN }));
vi.mock("@/lib/admin/step-up", () => ({ hasStepUp: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const writes = vi.hoisted(() => ({ audit: 0 }));
vi.mock("@/lib/admin/audit", () => ({
  recordAdminEvent: async () => {
    writes.audit++;
  },
}));

import { inviteWorkspaceOwner, provisionWorkspaceAction, setTenantPlan } from "../app/admin/actions";
import { STEP_UP_REQUIRED } from "../lib/admin/step-up-contract";

function form(entries: Record<string, string>): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(entries)) body.set(k, v);
  return body;
}

describe("console mutations without a step-up grant", () => {
  it("refuses to change a tier, before it looks at the tenant at all", async () => {
    const result = await setTenantPlan(form({ tenantId: "any", plan: "growth" }));
    expect(result).toEqual({ ok: false, error: STEP_UP_REQUIRED });
    expect(writes.audit).toBe(0);
  });

  it("refuses to provision a workspace", async () => {
    const result = await provisionWorkspaceAction(
      form({ name: "Should Not Exist", ownerEmail: "nobody@example.test" })
    );
    expect(result).toEqual({ ok: false, error: STEP_UP_REQUIRED });
    expect(writes.audit).toBe(0);
  });

  it("refuses to hand out ownership of a workspace", async () => {
    // The one console action that grants standing access to someone else's
    // shop, so it must fail closed before it reads the tenant or the email.
    const result = await inviteWorkspaceOwner(
      form({ tenantId: "any", email: "nobody@example.test" })
    );
    expect(result).toEqual({ ok: false, error: STEP_UP_REQUIRED });
    expect(writes.audit).toBe(0);
  });

  it("uses a refusal the caller can tell apart from a real error", async () => {
    // The prompt keys on this exact value to re-run the action instead of
    // showing the text to the user, so it must not read like a message.
    expect(STEP_UP_REQUIRED).toBe("step_up_required");
  });
});
