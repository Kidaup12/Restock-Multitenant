"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@wezesha/db";
import type { PermissionSource } from "@/lib/auth/permissions";
import { MenuIcon } from "@/components/icons";
import { navSectionsFor } from "@/components/shell/nav-config";
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

/** The rail's fixed width (232px), and the offset the content column carries to
 *  clear it. One number, so the two can never disagree. */
const RAIL_W = "14.5rem" as const;

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
  connection: {
    state: ConnectionState;
    canFix: boolean;
    stale: Staleness | null;
    /** "7h ago", or null when nothing has ever arrived. */
    syncedAgo: string | null;
  } | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const permissionSource: PermissionSource | null = workspace
    ? { role: workspace.role, permissions: workspace.permissions ?? null }
    : null;

  /*
   * The drawer remembers which page it was opened over, and is open only while
   * that is still the page. Navigating therefore closes it on the very render
   * that shows the new route — a menu left standing over the page you just asked
   * for reads as a failed tap.
   *
   * Derived rather than an effect that resets it: an effect would close the
   * drawer one render late, after a frame of the new page behind the old menu.
   */
  const [openedOver, setOpenedOver] = useState<string | null>(null);
  const open = openedOver !== null && openedOver === pathname;
  const setOpen = (next: boolean) => setOpenedOver(next ? pathname : null);

  // The page behind it does not scroll while it is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const rail = (
    <RailContent
      user={user}
      workspace={workspace}
      workspaces={workspaces}
      permissionSource={permissionSource}
      unreadNotifications={unreadNotifications}
      isPlatformAdmin={isPlatformAdmin}
      syncedAgo={connection?.syncedAgo ?? null}
    />
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
      {/* Mobile bar: the only chrome above the content below lg. The bell sits
          here rather than inside the drawer so an unread count is visible
          without opening anything. */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-edge bg-surface/95 px-4 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          data-tour="nav-menu"
          className="-ml-1 grid size-9 place-items-center rounded-md text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <MenuIcon className="size-4.5" />
        </button>
        <Brand />
        <div className="ml-auto">
          <NotificationBell
            initialUnread={unreadNotifications}
            workspaceId={workspace?.id ?? null}
          />
        </div>
      </header>

      {/* Mobile drawer — the same rail, slid over the page. */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-ink-strong/30"
          />
          <div className="absolute inset-y-0 left-0 flex w-[16.25rem] animate-[rail-in_180ms_cubic-bezier(0.22,1,0.36,1)] flex-col border-r border-edge bg-sidebar shadow-pop">
            {rail}
          </div>
        </div>
      )}

      {/* Desktop rail — fixed, so the content column scrolls under it. */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-edge bg-sidebar lg:flex"
        style={{ width: RAIL_W }}
      >
        {rail}
      </aside>

      <div className="lg:pl-[14.5rem]">
        {connection && (
          <ConnectionBanner
            state={connection.state}
            canFix={connection.canFix}
            stale={connection.stale}
          />
        )}
        <main className="min-h-dvh px-5 py-7 sm:px-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
          {/* Says what this is and who stands behind it. The rail carries the
              wordmark and nothing else; a shop owner three screens deep has no
              other reminder of what they are looking at. */}
          <footer className="mx-auto mt-10 w-full max-w-7xl border-t border-edge pt-4 text-2xs text-ink-faint">
            Wezesha Restock OS · demand &amp; reorder intelligence for beauty retailers
            <span className="px-1.5">·</span>
            <Link href="/terms" className="hover:text-ink-muted">
              Terms
            </Link>
            <span className="px-1.5">·</span>
            <Link href="/privacy" className="hover:text-ink-muted">
              Privacy
            </Link>
          </footer>
        </main>
      </div>
    </TourProvider>
    </RouteLoadingProvider>
    </RealtimeConnectionProvider>
    </CurrencyProvider>
  );
}

/** The wordmark. A gradient tile rather than a flat accent square — the one
 *  place the brand spends the full accent ramp. */
function Brand() {
  return (
    <Link href="/today" className="flex min-w-0 items-center gap-2.5">
      <div className="size-7 shrink-0 rounded-md bg-gradient-to-br from-accent-500 to-accent-700" />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[15px] font-semibold tracking-tight text-ink">Wezesha</div>
        <div className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">Restock OS</div>
      </div>
    </Link>
  );
}

/**
 * Everything inside the rail, rendered identically on desktop and in the mobile
 * drawer so the two can never drift apart.
 *
 * The four controls at the foot were a top header row until the shell moved to a
 * rail-only layout. They are here because the reference build has no header to
 * hang them on — not because they became less important.
 */
function RailContent({
  user,
  workspace,
  workspaces,
  permissionSource,
  unreadNotifications,
  isPlatformAdmin,
  syncedAgo,
}: {
  user: ShellUser;
  workspace: ShellWorkspace;
  workspaces: WorkspaceOption[];
  permissionSource: PermissionSource | null;
  unreadNotifications: number;
  isPlatformAdmin: boolean;
  syncedAgo: string | null;
}) {
  const { lead, sections } = navSectionsFor(permissionSource);

  return (
    <>
      <div className="flex h-16 shrink-0 items-center border-b border-edge px-4">
        <Brand />
      </div>

      <nav className="no-scrollbar flex-1 space-y-5 overflow-y-auto px-2.5 py-4">
        {lead.length > 0 && (
          <div className="space-y-0.5">
            {lead.map((item) => (
              <NavItem key={item.href} {...item} />
            ))}
          </div>
        )}
        {sections.map((section) => (
          <div key={section.key}>
            <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
              {section.label}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavItem key={item.href} {...item} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="shrink-0 space-y-1.5 border-t border-edge px-3 py-2">
        {/* Answers "is this current?" wherever the reader is, without a trip to
            Connections. The banner above only speaks once a store has been
            silent for a day; most of the time the useful answer is "an hour
            ago". */}
        {syncedAgo && (
          <Link
            href="/settings/connections"
            className="block px-1 text-2xs text-ink-faint hover:text-ink-muted"
          >
            Synced {syncedAgo}
          </Link>
        )}
        {workspaces.length > 0 ? (
          <WorkspaceSwitcher workspaces={workspaces} activeId={workspace?.id ?? null} />
        ) : (
          <p className="px-1 text-2xs text-ink-muted">
            <Link href="/workspaces/new" className="font-medium text-accent-ink hover:underline">
              Create a workspace
            </Link>{" "}
            or ask for an invite
          </p>
        )}
        <div className="flex items-center gap-0.5">
          <ProfileMenu
            name={user.name}
            email={user.email}
            roleLabel={workspace ? workspace.roleLabel : "No workspace"}
            isPlatformAdmin={isPlatformAdmin}
          />
          <div className="ml-auto flex items-center gap-0.5">
            {/* Desktop only: on mobile this lives in the top bar, where it can be
                seen without opening the drawer. */}
            <span className="hidden lg:inline-flex">
              {/* Bottom-left corner of the sidebar: the panel has to open
                  upward and to the right, or it lands off screen. */}
              <NotificationBell
                initialUnread={unreadNotifications}
                workspaceId={workspace?.id ?? null}
                placement="above-start"
              />
            </span>
            <ThemeToggle data-tour="theme-toggle" />
          </div>
        </div>
      </div>
    </>
  );
}
