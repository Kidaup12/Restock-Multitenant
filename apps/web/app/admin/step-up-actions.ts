"use server";

import { revalidatePath } from "next/cache";
import { PLATFORM_TENANT_ID } from "@wezesha/db";
import { requireAdmin } from "@/lib/admin/gate";
import { recordAdminEvent } from "@/lib/admin/audit";
import {
  grantStepUp,
  grantStepUpByCode,
  requestStepUpCode,
  stepUpMethod,
} from "@/lib/admin/step-up";

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

/** Whether this admin is asked for a password or a code. An account created
 *  through email-code sign-in has no password to be asked for. */
export async function stepUpFactor(): Promise<"password" | "code"> {
  return stepUpMethod(await requireAdmin());
}

/** Send the admin a one-time code. Not audited and not throttled: a delivery
 *  attempt proves nothing, and counting it would let a locked-out admin be
 *  kept out by the very request meant to let them back in. */
export async function sendStepUpCode(): Promise<StepUpActionResult> {
  const result = await requestStepUpCode(await requireAdmin());
  return result.ok ? { ok: true } : { ok: false, error: result.message };
}

/** Confirm a one-time code and mint the same grant the password route mints. */
export async function confirmStepUpCode(formData: FormData): Promise<StepUpActionResult> {
  const admin = await requireAdmin();
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { ok: false, error: "Enter the code we emailed you." };

  const result = await grantStepUpByCode(admin, code);

  if (result.ok) {
    await recordAdminEvent({
      tenantId: PLATFORM_TENANT_ID,
      action: "step_up_granted",
      admin,
    });
    revalidatePath("/admin", "layout");
    return { ok: true };
  }

  // Same rule as the password route: only a genuinely wrong answer is logged,
  // so a lockout cannot be used to fill the ledger.
  if (result.reason === "wrong_code") {
    await recordAdminEvent({
      tenantId: PLATFORM_TENANT_ID,
      action: "step_up_failed",
      admin,
    });
  }

  return { ok: false, error: result.message };
}

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
