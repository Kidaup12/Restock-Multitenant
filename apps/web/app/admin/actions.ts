"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin/gate";
import { recordAdminEvent } from "@/lib/admin/audit";
import {
  ADMIN_TENANT_COOKIE,
  ADMIN_TENANT_TTL_MS,
  clearAdminTenantCookie,
  setAdminTenantCookie,
  verifyAdminTenant,
} from "@/lib/admin/impersonation";
import { tenantExists } from "@/lib/admin/fleet";

/**
 * Workspace entry/exit for the admin console. Entering is the audited event:
 * one impersonation_start row per grant (not per page view — the grant IS the
 * session), one impersonation_end when the admin explicitly leaves.
 */

export async function enterWorkspace(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenantId") ?? "");
  if (!tenantId || !(await tenantExists(tenantId))) notFound();

  await recordAdminEvent({
    tenantId,
    action: "impersonation_start",
    admin,
    meta: { expiresAt: new Date(Date.now() + ADMIN_TENANT_TTL_MS).toISOString() },
  });
  await setAdminTenantCookie(tenantId);
  redirect(`/admin/tenant/${tenantId}`);
}

export async function exitWorkspace(): Promise<void> {
  const admin = await requireAdmin();
  // End event only when a live grant exists; an expired grant already ended
  // itself (start rows carry their expiresAt, so the window stays auditable).
  const value = (await cookies()).get(ADMIN_TENANT_COOKIE)?.value;
  const tenantId = verifyAdminTenant(value);
  if (tenantId) {
    await recordAdminEvent({ tenantId, action: "impersonation_end", admin });
  }
  await clearAdminTenantCookie();
  redirect("/admin");
}
