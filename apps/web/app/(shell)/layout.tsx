import type { Role } from "@wezesha/db";
import { activeMembership, listMemberships, requireSession } from "@/lib/auth";
import { AppShell } from "@/components/shell/app-shell";

const roleLabels: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

export default async function ShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const [membership, memberships] = await Promise.all([
    activeMembership(session.user.id),
    listMemberships(session.user.id),
  ]);

  return (
    <AppShell
      user={{ name: session.user.name, email: session.user.email }}
      workspace={
        membership
          ? {
              id: membership.tenantId,
              name: membership.tenant.name,
              roleLabel: roleLabels[membership.role],
              role: membership.role,
            }
          : null
      }
      workspaces={memberships.map((m) => ({
        id: m.tenantId,
        name: m.tenant.name,
        roleLabel: roleLabels[m.role],
      }))}
      tourAutoStart={membership !== null && membership.welcomedAt === null}
    >
      {children}
    </AppShell>
  );
}
