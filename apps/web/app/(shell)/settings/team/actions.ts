"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import {
  cancelInvite,
  createInvite,
  sendInviteEmail,
  type InviteRole,
} from "@/lib/auth/invites";
import { hasPermission } from "@/lib/auth/permissions";
import { invitableRoles, type TeamActor } from "@/lib/auth/team-guards";
import { changeMemberRoleGuarded, removeMemberGuarded } from "@/lib/auth/team-mutations";

/**
 * Team management actions. Every action re-resolves the caller's active
 * membership and re-runs the guard rules server-side — the page's per-row UI
 * state is a convenience, not the enforcement. Targets are loaded through the
 * tenant-scoped client, so a membership id from another tenant resolves to
 * nothing under RLS.
 */

export type TeamActionResult = { ok: true } | { ok: false; error: string };

const err = (error: string): TeamActionResult => ({ ok: false, error });

async function actorContext() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  const actor: TeamActor = {
    membershipId: membership.id,
    role: membership.role,
    permissions: membership.permissions,
  };
  return { session, membership, actor };
}

function isInviteRole(value: string): value is InviteRole {
  return value === "ADMIN" || value === "MEMBER";
}

function isRole(value: string): value is Role {
  return value === "OWNER" || value === "ADMIN" || value === "MEMBER";
}

export async function inviteTeammate(input: {
  email: string;
  role: string;
}): Promise<TeamActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You're not in a workspace.");
  const { session, membership, actor } = ctx;
  if (!hasPermission(actor, "manage_team")) {
    return err("You don't have team management access.");
  }
  if (!isInviteRole(input.role) || !invitableRoles(actor).includes(input.role)) {
    return err("You can't grant that role.");
  }
  const created = await createInvite({
    tenantId: membership.tenantId,
    email: input.email,
    role: input.role,
  });
  if (!created.ok) return err(created.error);
  try {
    await sendInviteEmail({
      invite: created.invite,
      tenantName: membership.tenant.name,
      invitedBy: session.user.name || session.user.email,
    });
  } catch {
    // The invite row is written before the email is sent, so a delivery failure
    // used to leave a pending invite nobody could act on: the admin saw the
    // action fail, the teammate never got a link, and the ghost occupied the
    // invite list until it expired. Take it back so the admin can simply retry.
    await cancelInvite(membership.tenantId, created.invite.token);
    revalidatePath("/settings/team");
    return err("We couldn't send the invite email, so nothing was invited. Try again in a moment.");
  }
  revalidatePath("/settings/team");
  return { ok: true };
}

export async function cancelTeamInvite(input: {
  token: string;
}): Promise<TeamActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You're not in a workspace.");
  if (!hasPermission(ctx.actor, "manage_team")) {
    return err("You don't have team management access.");
  }
  await cancelInvite(ctx.membership.tenantId, input.token);
  revalidatePath("/settings/team");
  return { ok: true };
}

export async function changeMemberRole(input: {
  membershipId: string;
  role: string;
}): Promise<TeamActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You're not in a workspace.");
  if (!isRole(input.role)) return err("Unknown role.");
  const guard = await changeMemberRoleGuarded(
    ctx.membership.tenantId,
    ctx.actor,
    input.membershipId,
    input.role,
  );
  if (!guard.ok) return err(guard.reason);
  revalidatePath("/settings/team");
  return { ok: true };
}

export async function removeMember(input: {
  membershipId: string;
}): Promise<TeamActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You're not in a workspace.");
  const guard = await removeMemberGuarded(
    ctx.membership.tenantId,
    ctx.actor,
    input.membershipId,
  );
  if (!guard.ok) return err(guard.reason);
  // Removing yourself changes what the whole shell should show.
  revalidatePath("/", "layout");
  return { ok: true };
}
