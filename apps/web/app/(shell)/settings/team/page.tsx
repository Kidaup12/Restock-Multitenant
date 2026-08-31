import type { Metadata } from "next";
import { prismaForTenant, Role } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { listInvites } from "@/lib/auth/invites";
import { hasPermission, resolvePermissions } from "@/lib/auth/permissions";
import { checkLimit } from "@/lib/limits/evaluate";
import {
  GRANTABLE_PERMISSIONS,
  canChangeRole,
  canRemoveMember,
  canSetPermissions,
  invitableRoles,
  type TeamActor,
} from "@/lib/auth/team-guards";
import { UsersIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { TeamView } from "./team-view";

export const metadata: Metadata = {
  title: "Team",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const ALL_ROLES: Role[] = [Role.OWNER, Role.ADMIN, Role.MEMBER];

export default async function TeamPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Settings" title="Team" description="Who has access to this workspace" />
        <EmptyState
          icon={<UsersIcon />}
          title="No workspace"
          description="You're not a member of any workspace yet. Ask an admin for an invite."
        />
      </div>
    );
  }

  const db = prismaForTenant(membership.tenantId);
  const members = await db.membership.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  const ownerCount = members.filter((m) => m.role === "OWNER").length;

  const actor: TeamActor = {
    membershipId: membership.id,
    role: membership.role,
    permissions: membership.permissions,
  };
  const canManage = hasPermission(actor, "manage_team");
  const invites = canManage ? await listInvites(membership.tenantId) : [];
  // The seat cap, read where the invite form is drawn rather than only inside
  // the action. A form that accepts an address, sends it, and only then says the
  // plan is full is a dead end dressed as a working control.
  const seats = canManage ? await checkLimit(membership.tenantId, "invite_member") : null;

  // Per-row allowed actions, precomputed with the same guards the actions
  // re-run server-side.
  const rows = members.map((member) => {
    const target = { membershipId: member.id, role: member.role };
    return {
      id: member.id,
      name: member.displayName ?? member.user.name,
      email: member.user.email,
      role: member.role,
      joined: dateFormat.format(member.createdAt),
      isSelf: member.id === membership.id,
      roleOptions: ALL_ROLES.filter(
        (role) => canChangeRole(actor, target, role, ownerCount).ok,
      ),
      canRemove: canRemoveMember(actor, target, ownerCount).ok,
      // What this person may actually do right now, and whether it is their
      // own choice of permissions or just their role's preset — the difference
      // is what the reader needs to understand the row.
      permissions: [...resolvePermissions(member)],
      hasOverride: Array.isArray(member.permissions),
      canSetPermissions: canSetPermissions(actor, target, []).ok,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Team" }]}
        title="Team"
        description={`Who has access to ${membership.tenant.name}`}
      />
      <TeamView
        grantable={[...GRANTABLE_PERMISSIONS]}
        rows={rows}
        invites={invites.map((invite) => ({
          token: invite.token,
          email: invite.email,
          role: invite.role,
          expires: dateFormat.format(invite.expiresAt),
        }))}
        canManage={canManage}
        inviteRoles={invitableRoles(actor)}
        seats={seats && { allowed: seats.allowed, used: seats.used, max: seats.max, message: seats.message }}
      />
    </div>
  );
}
