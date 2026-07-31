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
import { customerWorkspaceExists } from "@/lib/admin/fleet";
import { provisionWorkspace } from "@/lib/admin/provision";

/**
 * Workspace entry/exit for the admin console. Entering is the audited event:
 * one impersonation_start row per grant (not per page view — the grant IS the
 * session), one impersonation_end when the admin explicitly leaves.
 */

export async function enterWorkspace(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenantId") ?? "");
  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();

  await recordAdminEvent({
    tenantId,
    action: "impersonation_start",
    admin,
    meta: { expiresAt: new Date(Date.now() + ADMIN_TENANT_TTL_MS).toISOString() },
  });
  await setAdminTenantCookie(tenantId);
  redirect(`/admin/tenant/${tenantId}`);
}

export type ProvisionActionResult =
  | { ok: true; tenantId: string; slug: string; message: string }
  | { ok: false; error: string };

/**
 * Create a workspace for a customer and hand it to its owner.
 *
 * The gap this closes: a shop that has agreed to use the product could only be
 * set up by someone with database access, because the sole path to a workspace
 * was a person signing up and making their own. That is also the workaround
 * while Shopify review gates self-serve installs.
 *
 * Audited against the workspace it created, with how the owner was given it —
 * an operator minting workspaces is exactly the action worth being able to
 * account for later.
 */
export async function provisionWorkspaceAction(formData: FormData): Promise<ProvisionActionResult> {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "");
  const ownerEmail = String(formData.get("ownerEmail") ?? "");

  const result = await provisionWorkspace({ name, ownerEmail });
  if (!result.ok) return result;

  await recordAdminEvent({
    tenantId: result.tenantId,
    action: "workspace_provisioned",
    admin,
    meta: {
      name,
      ownerEmail: result.owner.status === "member" ? result.owner.email : result.owner.invite.email,
      ownerStatus: result.owner.status,
    },
  });

  revalidatePath("/admin");
  return {
    ok: true,
    tenantId: result.tenantId,
    slug: result.slug,
    message:
      result.owner.status === "member"
        ? `Created ${result.slug} — the owner already had an account and can use it now.`
        : `Created ${result.slug} — an owner invite has been emailed. It expires in 7 days.`,
  };
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
 * someone else's workspace — so `customerWorkspaceExists` is the guard, and the write goes
 * through that tenant's own scoped client. Tenant carries no RLS policy of its
 * own, so the id scope IS the isolation and it is never taken on trust.
 */
export async function setTenantPlan(formData: FormData): Promise<SetPlanResult> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenantId") ?? "");
  const plan = String(formData.get("plan") ?? "");

  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();
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
