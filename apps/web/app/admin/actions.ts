"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { prismaForTenant } from "@wezesha/db";
import { toPlanTier } from "@/lib/capabilities/plan-features";
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

export type SetPlanResult = { ok: true; plan: string } | { ok: false; error: string };

/**
 * Move a workspace between billing tiers.
 *
 * Until now `Tenant.plan` was written once at provisioning and never again, so
 * changing a customer's tier meant a hand-written UPDATE against production.
 * Insights, Transfers, the budget planner and supplier PO email are all gated on
 * it, which made the screens the product is demoed on unreachable without
 * database access.
 *
 * The tenant id comes from input here — it has to, since an operator acts on
 * someone else's workspace — so `tenantExists` is the guard, and the write goes
 * through that tenant's own scoped client. Tenant carries no RLS policy of its
 * own, so the id scope IS the isolation and it is never taken on trust.
 */
export async function setTenantPlan(formData: FormData): Promise<SetPlanResult> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenantId") ?? "");
  const plan = String(formData.get("plan") ?? "");

  if (!tenantId || !(await tenantExists(tenantId))) notFound();
  // Normalised, not taken as typed: the tier aliases accept "Essential" but only
  // the canonical key belongs in the column.
  const tier = toPlanTier(plan);
  if (!tier) return { ok: false, error: "Unknown plan." };

  const db = prismaForTenant(tenantId);
  const before = await db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  if (!before) return { ok: false, error: "That workspace no longer exists." };
  if (before.plan === tier) return { ok: true, plan: tier };

  await db.tenant.update({ where: { id: tenantId }, data: { plan: tier } });
  // Logged even though nothing else on this surface writes tenant data: a tier
  // change moves what a customer can reach and what they are billed, so it is
  // the one admin action most likely to be asked about later.
  await recordAdminEvent({
    tenantId,
    action: "plan_changed",
    admin,
    meta: { from: before.plan, to: tier },
  });

  // The plan gates Insights, Transfers, the budget planner and PO email, so the
  // customer's own screens change too — not just this console.
  revalidatePath("/admin/tenant/[id]", "page");
  revalidatePath("/admin");
  return { ok: true, plan: tier };
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
