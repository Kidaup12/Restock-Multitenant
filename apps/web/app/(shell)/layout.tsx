import type { Role } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
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
  const membership = await activeMembership(session.user.id);

  return (
    <AppShell
      user={{ name: session.user.name, email: session.user.email }}
      workspace={
        membership
          ? {
              name: membership.tenant.name,
              roleLabel: roleLabels[membership.role],
            }
          : null
      }
    >
      {children}
    </AppShell>
  );
}
