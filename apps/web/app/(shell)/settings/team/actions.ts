"use server";

import { revalidatePath } from "next/cache";
import { prismaForTenant, type Role } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import {
  cancelInvite,
  createInvite,
  sendInviteEmail,
  type InviteRole,
} from "@/lib/auth/invites";
import { hasPermission } from "@/lib/auth/permissions";
import {
  canChangeRole,
  canRemoveMember,
  invitableRoles,
  type TeamActor,
} from "@/lib/auth/team-guards";

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
  await sendInviteEmail({
    invite: created.invite,
    tenantName: membership.tenant.name,
    invitedBy: session.user.name || session.user.email,
  });
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
  const db = prismaForTenant(ctx.membership.tenantId);
  const target = await db.membership.findUnique({
    where: { id: input.membershipId },
    select: { id: true, role: true },
  });
  if (!target) return err("That member no longer exists.");
  const ownerCount = await db.membership.count({ where: { role: "OWNER" } });
  const guard = canChangeRole(
    ctx.actor,
    { membershipId: target.id, role: target.role },
    input.role,
    ownerCount,
  );
  if (!guard.ok) return err(guard.reason);
  await db.membership.update({
    where: { id: target.id },
    data: { role: input.role },
  });
  revalidatePath("/settings/team");
  return { ok: true };
}

export async function removeMember(input: {
  membershipId: string;
}): Promise<TeamActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You're not in a workspace.");
  const db = prismaForTenant(ctx.membership.tenantId);
  const target = await db.membership.findUnique({
    where: { id: input.membershipId },
    select: { id: true, role: true },
  });
  if (!target) return err("That member no longer exists.");
  const ownerCount = await db.membership.count({ where: { role: "OWNER" } });
  const guard = canRemoveMember(
    ctx.actor,
    { membershipId: target.id, role: target.role },
    ownerCount,
  );
  if (!guard.ok) return err(guard.reason);
  await db.membership.delete({ where: { id: target.id } });
  // Removing yourself changes what the whole shell should show.
  revalidatePath("/", "layout");
  return { ok: true };
}
