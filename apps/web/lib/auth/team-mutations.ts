import { Prisma, prismaForTenantTx, type Role } from "@wezesha/db";
import {
  canChangeRole,
  canRemoveMember,
  canSetPermissions,
  type GuardResult,
  type TeamActor,
} from "@/lib/auth/team-guards";
import type { PermissionKey } from "@/lib/auth/permissions";

/**
 * The two team writes whose guard depends on a COUNT of owners rather than on
 * the target row alone. Read-count-then-write across three statements is a
 * check-then-act race: in a two-owner workspace, each owner demoting the other
 * at the same moment reads ownerCount = 2, passes the last-owner guard, and
 * both writes land — a workspace with zero owners, which nothing in the app can
 * recover from (OWNER gates export, delete, and every role grant).
 *
 * A conditional single-row write can't express an aggregate condition, so these
 * take a per-workspace advisory lock — the same idiom PO numbering uses — and
 * re-read the target plus the owner count inside the transaction. The second
 * caller then counts one owner and is refused.
 */

async function lockTeam(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`team:${tenantId}`}, 0))`;
}

const gone: GuardResult = { ok: false, reason: "That member no longer exists." };

export function changeMemberRoleGuarded(
  tenantId: string,
  actor: TeamActor,
  membershipId: string,
  nextRole: Role,
): Promise<GuardResult> {
  return prismaForTenantTx(tenantId, async (tx) => {
    await lockTeam(tx, tenantId);
    const target = await tx.membership.findUnique({
      where: { id: membershipId },
      select: { id: true, role: true },
    });
    if (!target) return gone;
    const ownerCount = await tx.membership.count({ where: { role: "OWNER" } });
    const guard = canChangeRole(
      actor,
      { membershipId: target.id, role: target.role },
      nextRole,
      ownerCount,
    );
    if (!guard.ok) return guard;
    await tx.membership.update({ where: { id: target.id }, data: { role: nextRole } });
    return { ok: true };
  });
}

/**
 * Set one member's explicit permissions, or `null` to go back to inheriting the
 * role's preset.
 *
 * No owner count is involved, so this needs no advisory lock — but it takes the
 * same shape as its neighbours so the guard always runs against the row as it
 * is at write time, not as it was when the page rendered.
 */
export function setMemberPermissionsGuarded(
  tenantId: string,
  actor: TeamActor,
  membershipId: string,
  next: readonly PermissionKey[] | null,
): Promise<GuardResult> {
  return prismaForTenantTx(tenantId, async (tx) => {
    const target = await tx.membership.findUnique({
      where: { id: membershipId },
      select: { id: true, role: true },
    });
    if (!target) return gone;
    const guard = canSetPermissions(actor, { membershipId: target.id, role: target.role }, next ?? []);
    if (!guard.ok) return guard;
    await tx.membership.update({
      where: { id: target.id },
      // null clears the override; an array (even empty) is an explicit grant.
      data: { permissions: next === null ? Prisma.DbNull : [...next] },
    });
    return { ok: true };
  });
}

export function removeMemberGuarded(
  tenantId: string,
  actor: TeamActor,
  membershipId: string,
): Promise<GuardResult> {
  return prismaForTenantTx(tenantId, async (tx) => {
    await lockTeam(tx, tenantId);
    const target = await tx.membership.findUnique({
      where: { id: membershipId },
      select: { id: true, role: true },
    });
    if (!target) return gone;
    const ownerCount = await tx.membership.count({ where: { role: "OWNER" } });
    const guard = canRemoveMember(actor, { membershipId: target.id, role: target.role }, ownerCount);
    if (!guard.ok) return guard;
    await tx.membership.delete({ where: { id: target.id } });
    return { ok: true };
  });
}
