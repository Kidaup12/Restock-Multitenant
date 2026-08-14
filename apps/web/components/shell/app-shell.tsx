"use client";

import { useState } from "react";
import Link from "next/link";
import type { Role } from "@wezesha/db";
import { cn } from "@/lib/cn";
import type { PermissionSource } from "@/lib/auth/permissions";
import { ChevronsLeftIcon, DotsIcon } from "@/components/icons";
import {
  navFor,
  TAB_BAR_HREFS,
  TAB_BAR_LABEL,
} from "@/components/shell/nav-config";
import { NavItem } from "@/components/shell/nav-item";
import { ConnectionBanner, type Staleness } from "@/components/shell/connection-banner";
import type { ConnectionState } from "@/lib/admin/fleet";
import { RouteLoadingProvider } from "@/components/shell/route-loading";
import { NotificationBell } from "@/components/shell/notification-bell";
import { ProfileMenu } from "@/components/shell/profile-menu";
import {
  WorkspaceSwitcher,
  type WorkspaceOption,
} from "@/components/shell/workspace-switcher";
import { TourProvider } from "@/components/tour/tour-provider";
import { CurrencyProvider } from "@/components/currency-provider";
import { RealtimeConnectionProvider } from "@/components/realtime-connection";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/* Desktop rail = every destination this caller can use; mobile tab bar = the
 * promoted few plus a "More" entry for the overflow. Both derive from the shared
 * nav config so a new destination surfaces everywhere at once. */
function navsFor(membership: PermissionSource | null) {
  const sidebarNav = navFor(membership);
  return {
    sidebarNav,
    tabNav: [
      ...sidebarNav
        .filter((d) => TAB_BAR_HREFS.includes(d.href))
        .map((d) => ({ ...d, label: TAB_BAR_LABEL[d.href] ?? d.label })),
      { href: "/more", label: "More", icon: <DotsIcon />, tourKey: "nav-more" },
    ],
  };
}

export type ShellUser = {
  name: string;
  email: string;
};

/* null = the user has no membership yet ("No workspace" state). */
export type ShellWorkspace = {
  id: string;
  name: string;
  roleLabel: string;
  role: Role;
  /** The membership's permission override, if it has one. Omitted = inherit the
   *  role preset, which is what a membership with no override resolves to. */
  permissions?: unknown;
  /** Workspace currency; every money figure in the shell renders in it. */
  currency: string;
  /** Whether this workspace's plan can open Insights — the tour skips the step
   *  when it cannot, rather than walking a new owner onto a locked screen. */
  canOpenInsights: boolean;
} | null;

export function AppShell({
  user,
  workspace,
  workspaces,
  tourAutoStart,
  unreadNotifications,
  isPlatformAdmin,
  connection,
  children,
}: {
  user: ShellUser;
  workspace: ShellWorkspace;
  workspaces: WorkspaceOption[];
  /* First shell visit for this membership (welcomedAt still null). */
  tourAutoStart: boolean;
  /* Server-rendered seed for the bell badge; live updates take over client-side. */
  unreadNotifications: number;
  /* Caller is on the operator allow-list — the only thing that reveals /admin. */
  isPlatformAdmin: boolean;
  /* Whether this shop's data is still moving, and whether this caller can fix
     it. Null when there is no active workspace to have a connection. */
  connection: { state: ConnectionState; canFix: boolean; stale: Staleness | null } | null;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { sidebarNav, tabNav } = navsFor(
    workspace ? { role: workspace.role, permissions: workspace.permissions ?? null } : null,
  );

  return (
    <CurrencyProvider currency={workspace?.currency}>
    <RealtimeConnectionProvider workspaceId={workspace?.id ?? null}>
    <RouteLoadingProvider>
    <TourProvider
      role={workspace?.role ?? null}
      autoStart={tourAutoStart}
      canOpenInsights={workspace?.canOpenInsights ?? true}
    >
      <div className="flex min-h-dvh">
        {/* Desktop sidebar rail */}
        <aside
          className={cn(
            "sticky top-0 hidden h-dvh flex-col border-r border-edge bg-sidebar transition-[width] duration-200 md:flex",
            collapsed ? "w-[68px]" : "w-60",
          )}
        >
          <div className={cn("flex h-16 items-center gap-2.5 px-4", collapsed && "justify-center px-0")}>
            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-on-accent">
              W
            </div>
            {!collapsed && (
              <div className="leading-tight">
                <div className="font-display text-sm font-bold text-ink">Wezesha</div>
                <div className="text-[10px] tracking-wider text-ink-muted uppercase">
                  Restock OS
                </div>
              </div>
            )}
          </div>
          <nav className="flex-1 space-y-1 px-3 py-4">
            {sidebarNav.map((item) => (
              <NavItem key={item.href} {...item} collapsed={collapsed} />
            ))}
          </nav>
          <div className="space-y-1 border-t border-edge px-3 py-3">
            {workspaces.length > 0 && (
              <WorkspaceSwitcher
                workspaces={workspaces}
                activeId={workspace?.id ?? null}
                collapsed={collapsed}
              />
            )}
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={cn(
                "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-ink-muted transition-colors",
                "outline-accent hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2",
                collapsed && "justify-center px-0",
              )}
            >
              <ChevronsLeftIcon
                className={cn("size-4.5 shrink-0 transition-transform", collapsed && "rotate-180")}
              />
              {!collapsed && <span>Collapse</span>}
            </button>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-edge bg-page/85 px-4 backdrop-blur md:px-8">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="grid size-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-on-accent md:hidden">
                W
              </div>
              {/* Mobile: the workspace block is the switcher (the sidebar is
                  hidden there). Desktop keeps the static label. */}
              {workspaces.length > 0 && (
                <div className="min-w-0 md:hidden">
                  <WorkspaceSwitcher
                    workspaces={workspaces}
                    activeId={workspace?.id ?? null}
                    layout="header"
                  />
                </div>
              )}
              <div
                className={cn(
                  "min-w-0 leading-tight",
                  workspaces.length > 0 && "hidden md:block",
                )}
              >
                <div className="truncate text-sm font-semibold text-ink">
                  {workspace ? workspace.name : "No workspace"}
                </div>
                <div className="truncate text-xs text-ink-muted">
                  {workspace ? (
                    workspace.roleLabel
                  ) : (
                    <>
                      <Link
                        href="/workspaces/new"
                        className="font-medium text-accent-ink hover:underline"
                      >
                        Create one
                      </Link>{" "}
                      or ask for an invite
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle data-tour="theme-toggle" />
              <NotificationBell
                initialUnread={unreadNotifications}
                workspaceId={workspace?.id ?? null}
              />
              <ProfileMenu
                name={user.name}
                email={user.email}
                roleLabel={workspace ? workspace.roleLabel : "No workspace"}
                isPlatformAdmin={isPlatformAdmin}
              />
            </div>
          </header>

          {connection && (
            <ConnectionBanner
              state={connection.state}
              canFix={connection.canFix}
              stale={connection.stale}
            />
          )}

          <main className="flex-1 px-4 py-6 pb-24 md:px-8 md:py-8 md:pb-10">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>
        </div>

        {/* Mobile bottom tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-edge bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          {tabNav.map((item) => (
            <NavItem key={item.href} {...item} layout="tab" />
          ))}
        </nav>
      </div>
    </TourProvider>
    </RouteLoadingProvider>
    </RealtimeConnectionProvider>
    </CurrencyProvider>
  );
}
