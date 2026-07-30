import type { Role } from "@wezesha/db";
import { hasPermission, type PermissionSource } from "@/lib/auth/permissions";

/**
 * Team management guard rules. Pure so they are unit-testable and shared:
 * the server actions enforce them, the team page uses them to compute
 * per-row UI state.
 *
 * The ladder: `manage_team` gates everything; on top of it, touching an
 * OWNER/ADMIN member or granting those roles is OWNER-only, and a workspace
 * can never lose its last OWNER.
 */

export type GuardResult = { ok: true } | { ok: false; reason: string };

export type TeamActor = PermissionSource & { membershipId: string };
export type TeamTarget = { membershipId: string; role: Role };

const ok: GuardResult = { ok: true };
const no = (reason: string): GuardResult => ({ ok: false, reason });

/**
 * Roles the actor may put on an invite.
 *
 * Staff only, whoever is asking. A shop owner runs their shop; who else may own
 * or co-manage it is a platform decision, made by an operator in the admin
 * console, not something a workspace can grant itself. An owner who could mint
 * admins could hand out their own level of access, which is the escalation this
 * closes.
 *
 * Staff cannot invite at all — they have no `manage_team` — so the empty list
 * below is the whole rule for them.
 */
export function invitableRoles(actor: PermissionSource): Role[] {
  if (!hasPermission(actor, "manage_team")) return [];
  return ["MEMBER"];
}

export function canChangeRole(
  actor: TeamActor,
  target: TeamTarget,
  nextRole: Role,
  ownerCount: number,
): GuardResult {
  if (!hasPermission(actor, "manage_team")) {
    return no("You don't have team management access.");
  }
  if (actor.membershipId === target.membershipId) {
    return no("You can't change your own role.");
  }
  if (nextRole === target.role) return no("Already that role.");
  // Promotion out of staff is the same grant as inviting an admin or an owner,
  // by another door: closing one without the other just moves the escalation.
  if (nextRole !== "MEMBER") {
    return no("Only the platform team can grant admin and owner access.");
  }
  if (target.role !== "MEMBER" && actor.role !== "OWNER") {
    return no("Only an owner can change an admin or owner.");
  }
  if (target.role === "OWNER" && ownerCount <= 1) {
    return no("A workspace needs at least one owner.");
  }
  return ok;
}

export function canRemoveMember(
  actor: TeamActor,
  target: TeamTarget,
  ownerCount: number,
): GuardResult {
  if (!hasPermission(actor, "manage_team")) {
    return no("You don't have team management access.");
  }
  if (target.role !== "MEMBER" && actor.role !== "OWNER") {
    return no("Only an owner can remove admins and owners.");
  }
  if (target.role === "OWNER" && ownerCount <= 1) {
    return no("A workspace needs at least one owner.");
  }
  return ok;
}
