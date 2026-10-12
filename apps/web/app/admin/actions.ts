"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { Prisma, prismaForTenant } from "@wezesha/db";
import {
  parseFeatureOverrides,
  toPlanTier,
  PLAN_FEATURES,
  type FeatureOverride,
  type PlanFeature,
} from "@/lib/capabilities/plan-features";
import {
  FEATURE_DEFAULTS,
  featureEnabled,
  type FeatureKey,
} from "@/lib/capabilities/feature-flags";
import { requireAdmin } from "@/lib/admin/gate";
import { recordAdminEvent } from "@/lib/admin/audit";
import {
  ADMIN_TENANT_TTL_MS,
  endAdminWorkspace,
  setAdminTenantCookie,
} from "@/lib/admin/impersonation";
import { cancelInvite, createInvite, sendInviteEmail } from "@/lib/auth/invites";
import { customerWorkspaceExists } from "@/lib/admin/fleet";
import { provisionWorkspace } from "@/lib/admin/provision";
import { exportTenantJson } from "@/lib/offboarding/export";
import { deleteTenant } from "@/lib/offboarding/delete";
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
 * session), and one impersonation_end for every way of giving that grant back —
 * leaving, signing out, or entering somewhere else on top of it. Expiry is the
 * exception and says so at ADMIN_TENANT_TTL_MS.
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

  // Entering re-signs the cookie, so any visit already open ends here — with no
  // click and no sign-out of its own to record it. Closing it first keeps the
  // ledger balanced: one start, one end, in the order they happened.
  await endAdminWorkspace(admin, "superseded");

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

export type SetFeatureOverrideResult =
  | { ok: true; feature: string; value: FeatureOverride | "inherit" }
  | { ok: false; error: string };

/**
 * Grant or deny one plan feature for a single workspace, over the top of its
 * tier.
 *
 * The tier moves a customer between whole bundles; this is the finer knob for
 * the cases a tier can't express — a paid add-on on the entry plan, a pilot, a
 * make-good, or a feature pulled for one shop that misused it. "grant" turns it
 * on regardless of rank, "deny" turns it off regardless, and "inherit" removes
 * the override so the tier decides again.
 *
 * Copies setTenantPlan's skeleton exactly: requireAdmin, then step-up, then the
 * customer-workspace guard on the caller-supplied id, then the write through
 * that tenant's own scoped client (Tenant carries no RLS policy, so the id scope
 * IS the isolation), then the ledger, then revalidate. The override is merged
 * into the existing blob rather than overwriting it, so setting one feature
 * never clears another.
 */
export async function setTenantFeatureOverride(
  formData: FormData
): Promise<SetFeatureOverrideResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };
  const tenantId = String(formData.get("tenantId") ?? "");
  const feature = String(formData.get("feature") ?? "");
  const value = String(formData.get("value") ?? "");

  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();
  if (!Object.prototype.hasOwnProperty.call(PLAN_FEATURES, feature)) {
    return { ok: false, error: "Unknown feature." };
  }
  if (value !== "grant" && value !== "deny" && value !== "inherit") {
    return { ok: false, error: "Pick grant, deny, or inherit." };
  }
  const key = feature as PlanFeature;

  const db = prismaForTenant(tenantId);
  const before = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { featureOverrides: true },
  });
  if (!before) return { ok: false, error: "That workspace no longer exists." };

  // Parse to a clean map so a malformed blob can't survive a round-trip, then
  // set or clear just this key.
  const overrides = parseFeatureOverrides(before.featureOverrides);
  const previous = overrides[key] ?? "inherit";
  if (previous === value) {
    return { ok: true, feature: key, value };
  }
  if (value === "inherit") {
    delete overrides[key];
  } else {
    overrides[key] = value;
  }

  await db.tenant.update({
    where: { id: tenantId },
    // An empty map is stored as SQL NULL — the "pure tier" state the column
    // started in, so clearing the last override leaves no residue.
    data: {
      featureOverrides: Object.keys(overrides).length > 0 ? overrides : Prisma.DbNull,
    },
  });
  await recordAdminEvent({
    tenantId,
    action: "feature_override_changed",
    admin,
    meta: { feature: key, from: previous, to: value },
  });

  // The grant/deny gates the customer's own screens, so their surfaces change
  // too — not just this console.
  revalidatePath("/admin/tenant/[id]", "page");
  revalidatePath("/admin");
  return { ok: true, feature: key, value };
}

export type SetFeatureFlagResult =
  | { ok: true; feature: string; enabled: boolean }
  | { ok: false; error: string };

/**
 * Flip one tenant feature SWITCH (capability gate 4) from the console.
 *
 * These switches (transfers, pos_feed, quickbooks, supplier_email,
 * weekly_digest) had only one writer — the customer's own Settings — so support
 * could see a surface was off but could not turn it back on without database
 * access. This is that second writer, behind the same step-up.
 *
 * Distinct from the plan override above: that decides whether the PLAN includes
 * a feature, this decides whether the tenant has SWITCHED an included surface
 * on. Writes to TenantConfig.featureFlags, upserting because a workspace may
 * have no config row yet (every reader already treats a missing row as
 * defaults, so the first flip creates it).
 */
export async function setTenantFeatureFlag(formData: FormData): Promise<SetFeatureFlagResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };
  const tenantId = String(formData.get("tenantId") ?? "");
  const feature = String(formData.get("feature") ?? "");
  const rawEnabled = String(formData.get("enabled") ?? "");

  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();
  if (!Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, feature)) {
    return { ok: false, error: "Unknown feature." };
  }
  if (rawEnabled !== "true" && rawEnabled !== "false") {
    return { ok: false, error: "Say whether to turn it on or off." };
  }
  const key = feature as FeatureKey;
  const enabled = rawEnabled === "true";

  const db = prismaForTenant(tenantId);
  const before = await db.tenantConfig.findFirst({ select: { featureFlags: true } });
  // Read through the same resolver the app uses so "no change" is judged against
  // the effective value (stored-or-default), not a raw null.
  const current = featureEnabled(before ?? null, key);
  if (current === enabled) {
    return { ok: true, feature: key, enabled };
  }

  const flags =
    before?.featureFlags && typeof before.featureFlags === "object" && !Array.isArray(before.featureFlags)
      ? { ...(before.featureFlags as Record<string, unknown>) }
      : {};
  flags[key] = enabled;

  await db.tenantConfig.upsert({
    where: { tenantId },
    create: { tenantId, featureFlags: flags },
    update: { featureFlags: flags },
  });
  await recordAdminEvent({
    tenantId,
    action: "feature_override_changed",
    admin,
    meta: { switch: key, from: current, to: enabled },
  });

  revalidatePath("/admin/tenant/[id]", "page");
  revalidatePath("/admin");
  return { ok: true, feature: key, enabled };
}

export type SetBillingResult =
  | { ok: true; status: string; periodEnd: string | null }
  | { ok: false; error: string };

/**
 * Set a workspace's billing period and status from the console.
 *
 * There is no self-serve billing yet, so the period a customer is paid up to,
 * and whether they are active / trialing / past due / cancelled, is an operator
 * fact — kept here rather than in a hand-written UPDATE. The enforcement cron
 * reads planPeriodEnd/planStatus and, past a grace window, softens an expired
 * workspace to past_due; nothing here hard-locks anyone out.
 *
 * Three ways to set the period, mirroring the control: "extend" adds 30 days to
 * whichever is later of the current end or now (so extending an already-lapsed
 * workspace starts the new period from today, not from the past), "date" takes
 * an explicit YYYY-MM-DD, and "clear" removes it. A far-past explicit date is
 * refused — it is almost always a typo, and it would put a workspace straight
 * into the cron's sights.
 *
 * Same skeleton as setTenantPlan: requireAdmin, step-up, customer guard, scoped
 * write, ledger, revalidate.
 */
export async function setTenantBilling(formData: FormData): Promise<SetBillingResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };
  const tenantId = String(formData.get("tenantId") ?? "");
  const status = String(formData.get("status") ?? "");
  const periodMode = String(formData.get("periodMode") ?? "keep");
  const explicitDate = String(formData.get("periodEnd") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();

  const STATUSES = ["active", "trialing", "past_due", "canceled"];
  if (!STATUSES.includes(status)) return { ok: false, error: "Unknown billing status." };
  if (note.length > 500) return { ok: false, error: "Keep the note under 500 characters." };

  const db = prismaForTenant(tenantId);
  const before = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { planPeriodEnd: true, planStatus: true, billingNote: true },
  });
  if (!before) return { ok: false, error: "That workspace no longer exists." };

  const now = new Date();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  // Far past = a typo, not a real backdate. A cleared/never-set period is not
  // "far past" — only an explicit date typed decades ago is refused.
  const FAR_PAST = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  let periodEnd: Date | null = before.planPeriodEnd ?? null;
  if (periodMode === "extend") {
    // From the later of the current end or now, so extending a lapsed workspace
    // starts the fresh period today rather than tacking 30 days onto the past.
    const base = periodEnd && periodEnd.getTime() > now.getTime() ? periodEnd : now;
    periodEnd = new Date(base.getTime() + THIRTY_DAYS_MS);
  } else if (periodMode === "date") {
    if (!explicitDate) return { ok: false, error: "Pick a date." };
    // Parsed as a UTC day boundary so the same string means the same instant
    // regardless of where the operator or the server sits.
    const parsed = new Date(`${explicitDate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: "That date is not valid." };
    if (parsed.getTime() < FAR_PAST.getTime()) {
      return { ok: false, error: "That date is too far in the past — check it." };
    }
    periodEnd = parsed;
  } else if (periodMode === "clear") {
    periodEnd = null;
  } else if (periodMode !== "keep") {
    return { ok: false, error: "Unknown period change." };
  }

  await db.tenant.update({
    where: { id: tenantId },
    data: { planPeriodEnd: periodEnd, planStatus: status, billingNote: note || null },
  });
  await recordAdminEvent({
    tenantId,
    action: "billing_adjusted",
    admin,
    meta: {
      status: { from: before.planStatus, to: status },
      periodEnd: {
        from: before.planPeriodEnd?.toISOString() ?? null,
        to: periodEnd?.toISOString() ?? null,
      },
      noteChanged: (before.billingNote ?? "") !== (note || ""),
    },
  });

  revalidatePath("/admin/tenant/[id]", "page");
  revalidatePath("/admin");
  return { ok: true, status, periodEnd: periodEnd?.toISOString() ?? null };
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
  await endAdminWorkspace(admin, "exit");
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

/**
 * Offboarding from the operator side.
 *
 * Export and delete already existed as routes, but both gated on being OWNER of
 * the ACTIVE workspace — so removing a departing client's workspace needed
 * either their credentials or a Membership row written by hand (which is how it
 * was done on 2026-08-10). A platform admin can now do it for any workspace,
 * behind step-up, without ever joining it.
 *
 * The domain guards are untouched and still do the real work: `deleteTenant`
 * refuses unless the typed slug matches AND a fresh export exists in the ledger.
 * That ordering is the point — no restore drill has ever been performed against
 * the hosted database (tester issue #24), so the export IS the recovery plan
 * until one has.
 */
export type ExportWorkspaceResult =
  | { ok: true; filename: string; json: string }
  | { ok: false; error: string };

export async function exportWorkspaceAction(formData: FormData): Promise<ExportWorkspaceResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };

  const tenantId = String(formData.get("tenantId") ?? "");
  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();

  const tenant = await prismaForTenant(tenantId).tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true },
  });
  if (!tenant) notFound();

  // Records the "exported" audit row as a side effect — which is exactly what
  // unlocks deletion for the next 24 hours.
  const json = await exportTenantJson(tenantId, { userId: admin.userId, name: admin.name });
  return { ok: true, filename: `wezesha-export-${tenant.slug}.json`, json };
}

export type DeleteWorkspaceResult = { ok: true } | { ok: false; error: string };

export async function deleteWorkspaceAction(formData: FormData): Promise<DeleteWorkspaceResult> {
  const admin = await requireAdmin();
  if (!(await hasStepUp(admin))) return { ok: false, error: STEP_UP_REQUIRED };

  const tenantId = String(formData.get("tenantId") ?? "");
  const confirmSlug = String(formData.get("confirmSlug") ?? "");
  if (!tenantId || !(await customerWorkspaceExists(tenantId))) notFound();

  const result = await deleteTenant({
    tenantId,
    confirmSlug,
    // Not a rubber stamp: deleteTenant independently requires a fresh export
    // row in the ledger, so this flag cannot on its own delete anything.
    exportConfirmed: true,
    actorUserId: admin.userId,
    actorName: admin.name,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/admin");
  return { ok: true };
}
