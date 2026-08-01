"use server";

import { revalidatePath } from "next/cache";
import { PLATFORM_TENANT_ID } from "@wezesha/db";
import { requireAdmin } from "@/lib/admin/gate";
import { recordAdminEvent } from "@/lib/admin/audit";
import { grantStepUp } from "@/lib/admin/step-up";

/**
 * Confirm the admin's password and mint a step-up grant.
 *
 * Kept apart from actions.ts because everything there is guarded BY this; a
 * mutation module that also contains the way past its own guard is a file
 * nobody should have to read carefully.
 *
 * Both outcomes are logged against the platform workspace, but only a genuinely
 * wrong password is: a caller who is already locked out returns before the
 * ledger write, or the lockout would become a way to fill the audit log.
 */

export type StepUpActionResult = { ok: true } | { ok: false; error: string };

export async function confirmStepUp(formData: FormData): Promise<StepUpActionResult> {
  const admin = await requireAdmin();
  const password = String(formData.get("password") ?? "");
  if (!password) return { ok: false, error: "Enter your password." };

  const result = await grantStepUp(admin, password);

  if (result.ok) {
    await recordAdminEvent({
      tenantId: PLATFORM_TENANT_ID,
      action: "step_up_granted",
      admin,
    });
    // The console's own pages read the grant, so they have to re-render.
    revalidatePath("/admin", "layout");
    return { ok: true };
  }

  if (result.reason === "wrong_password") {
    await recordAdminEvent({
      tenantId: PLATFORM_TENANT_ID,
      action: "step_up_failed",
      admin,
    });
  }

  return { ok: false, error: result.message };
}
