import type { Role } from "@wezesha/db";
import { activeMembership, listMemberships, requireSession } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/admin/gate";
import { planAllows } from "@/lib/capabilities/plan-features";
import { hasPermission } from "@/lib/auth/permissions";
import { getUnreadCount } from "@/lib/notifications/data";
import { getConnectionStatus } from "@/lib/data/connection-status";
import { isStale, staleDays } from "@/lib/sync/staleness";
import { AppShell } from "@/components/shell/app-shell";
import { hasAcceptedCurrentTerms } from "@/lib/auth/terms";
import { TERMS_VERSION } from "@/lib/legal";
import { TermsGate } from "./terms-gate";

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
  const [membership, memberships, platformAdmin] = await Promise.all([
    activeMembership(session.user.id),
    listMemberships(session.user.id),
    // Alongside the others rather than after them: the admin list is now a
    // table, and this runs on every authenticated render of every screen.
    isPlatformAdmin(session),
  ]);
  // Match the badge to the feed the caller can actually open: cost alerts are
  // filtered out of a money-blind member's list, so counting them here would
  // leave a badge that never clears.
  const [unreadNotifications, connectionStatus] = membership
    ? await Promise.all([
        getUnreadCount(membership.tenantId, {
          canViewCosts: hasPermission(membership, "view_costs"),
        }),
        // Rides above every screen, so a shop whose sync has stopped finds out
        // on the page it is already looking at rather than only in Settings.
        getConnectionStatus(membership.tenantId),
      ])
    : [0, null];

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
              // The nav filters on effective permissions, not the role preset —
              // a member granted view_costs outright should see the Costs link.
              permissions: membership.permissions,
              // Already loaded — activeMembership includes the tenant — so this
              // costs nothing and every money figure below can read it.
              currency: membership.tenant.currency,
              canOpenInsights: planAllows(membership.tenant.plan, "insights"),
            }
          : null
      }
      workspaces={memberships.map((m) => ({
        id: m.tenantId,
        name: m.tenant.name,
        roleLabel: roleLabels[m.role],
      }))}
      tourAutoStart={membership !== null && membership.welcomedAt === null}
      unreadNotifications={unreadNotifications}
      /* Resolved server-side: the admin list never reaches the client, and a
         non-admin's shell carries no trace of /admin. A hint only — requireAdmin
         is what actually guards the console. */
      isPlatformAdmin={platformAdmin}
      connection={
        connectionStatus && membership
          ? {
              state: connectionStatus.state,
              // Pointing a member at a screen they cannot open is worse than
              // pointing them nowhere: the message still shows, the link does not.
              canFix: hasPermission(membership, "manage_settings"),
              // The clock is resolved here, on the server: the banner is a
              // render path and react-hooks/purity bans Date.now() inside one.
              stale: isStale(connectionStatus.lastSyncedAt)
                ? { days: staleDays(connectionStatus.lastSyncedAt) }
                : null,
            }
          : null
      }
    >
      {children}
      {/* Asked here rather than offered in Settings. Acceptance was recorded
          correctly but only if someone went looking for it, so the consent
          trail was empty for everyone who did not — which proves nothing. The
          shell is the one place both routes in arrive at: a new owner on first
          load, and an invited teammate the moment they join.

          Rendered alongside the children rather than instead of them so the
          page behind is already there when the gate clears — but it covers the
          viewport and has no dismiss, so nothing behind it can be used.

          Asked across every membership, not just the active one. A browser with
          no workspace cookie lands on the user's EARLIEST workspace, so keying
          this on the active membership re-asked people who had already agreed
          the moment they signed in somewhere new. */}
      {membership && !hasAcceptedCurrentTerms(memberships) && (
        <TermsGate version={TERMS_VERSION} />
      )}
    </AppShell>
  );
}
