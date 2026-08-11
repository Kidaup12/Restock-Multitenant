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
import { cancelInvite, createInvite, sendInviteEmail } from "@/lib/auth/invites";
import { customerWorkspaceExists } from "@/lib/admin/fleet";
import { provisionWorkspace } from "@/lib/admin/provision";
import { hasStepUp } from "@/lib/admin/step-up";
import {
  grantPlatformAdmin,
  revokePlatformAdmin,
  type AdminMutationResult,
} from "@/lib/admin/admins";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";

/**
 * Workspace entry/exit for the admin console. Entering is the audited event:
 * one impersonation_start row per grant (not per page view — the grant IS the
 * session), one impersonation_end when the admin explicitly leaves.
 *
 * Everything here that changes something asks for the password first. Reads do
 * not: gate the fleet and the audit log too and an admin keeps a grant warm all
 * day, which is the habit step-up exists to break. The sync trigger is
 * deliberately outside it — that re-runs a customer's own sync, chooses nothing,
 * and is audited either way.
 */

export async function enterWorkspace(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenantId") ?? "");
  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();

  // Void action with a redirect, so there is no result to carry a refusal:
  // send them to the prompt, which comes back and finishes the job. Both
  // parameters are ids this action already validated, never raw input.
  if (!(await hasStepUp(admin))) {
    redirect(`/admin/step-up?enter=${encodeURIComponent(tenantId)}`);
  }

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
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };
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
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };
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

export type InviteOwnerResult = { ok: true; email: string } | { ok: false; error: string };

/**
 * Invite a second owner to a workspace that already exists.
 *
 * Every other owner grant in the product is bound to workspace *creation*:
 * `createWorkspace` makes the founder an owner, and provisioning emails an owner
 * invite to a tenant it made moments earlier. Nothing could add one afterwards,
 * so "the shop changed hands" and "the client wants their colleague in" both had
 * no answer short of a hand-written INSERT.
 *
 * It lives here rather than in the workspace's own team screen on purpose.
 * `invitableRoles` deliberately caps every in-workspace actor at MEMBER
 * (lib/auth/team-guards.ts) — an owner who could mint owners could hand out
 * their own access, and closing only one of the two doors just moves the
 * escalation. Who owns a workspace stays an operator decision, made behind
 * step-up, and none of those guards are touched.
 */
export async function inviteWorkspaceOwner(formData: FormData): Promise<InviteOwnerResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };

  const tenantId = String(formData.get("tenantId") ?? "");
  const email = String(formData.get("email") ?? "");
  // Same guard as the plan control: the id arrives from input because an
  // operator acts on someone else's workspace, and Tenant carries no RLS policy
  // of its own, so the existence check IS the isolation.
  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();

  const tenant = await prismaForTenant(tenantId).tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
  });
  if (!tenant) return { ok: false, error: "That workspace no longer exists." };

  const invite = await createInvite({ tenantId, email, role: "OWNER" });
  if (!invite.ok) return { ok: false, error: invite.error };

  try {
    await sendInviteEmail({
      invite: invite.invite,
      tenantName: tenant.name,
      invitedBy: "The Wezesha Restock team",
    });
  } catch {
    // Same rule as the workspace's own invite form: the row is written before
    // the email goes out, so a delivery failure would otherwise leave a pending
    // invite nobody holds a link to, reading as "they were invited".
    await cancelInvite(tenantId, invite.invite.token);
    return { ok: false, error: "We couldn't send the invite email, so nothing was invited. Try again in a moment." };
  }

  await recordAdminEvent({
    tenantId,
    action: "owner_invited",
    admin,
    meta: { email: invite.invite.email },
  });

  revalidatePath("/admin/tenant/[id]", "page");
  return { ok: true, email: invite.invite.email };
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

/**
 * Grant and revoke console access.
 *
 * Both sit behind step-up like every other mutation here, and a fallback admin
 * (one holding access through ADMIN_EMAILS with no row of their own) cannot
 * reach them: step-up has nowhere to hold their throttle, so `hasStepUp` is
 * false for them by construction. That is the intended shape — the first admin
 * comes from the bootstrap script, every one after that comes through here.
 */
export async function grantPlatformAdminAction(
  formData: FormData
): Promise<AdminMutationResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };

  const result = await grantPlatformAdmin(admin, String(formData.get("email") ?? ""));
  if (result.ok) revalidatePath("/admin");
  return result;
}

export async function revokePlatformAdminAction(
  formData: FormData
): Promise<AdminMutationResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };

  const result = await revokePlatformAdmin(admin, String(formData.get("userId") ?? ""));
  if (result.ok) revalidatePath("/admin");
  return result;
}
