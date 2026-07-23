"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import {
  BellIcon,
  BoxIcon,
  BulbIcon,
  CalendarIcon,
  ChartIcon,
  ChevronsLeftIcon,
  ClipboardIcon,
  DotsIcon,
  GearIcon,
  HomeIcon,
} from "@/components/icons";
import { NavItem } from "@/components/shell/nav-item";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const sidebarNav = [
  { href: "/today", label: "Today", icon: <HomeIcon /> },
  { href: "/plan", label: "Plan", icon: <CalendarIcon /> },
  { href: "/orders", label: "Orders", icon: <ClipboardIcon /> },
  { href: "/stock", label: "Stock", icon: <BoxIcon /> },
  { href: "/sales", label: "Sales data", icon: <ChartIcon /> },
  { href: "/insights", label: "Insights", icon: <BulbIcon /> },
  { href: "/settings", label: "Settings", icon: <GearIcon /> },
];

const tabNav = [
  { href: "/today", label: "Today", icon: <HomeIcon /> },
  { href: "/plan", label: "Plan", icon: <CalendarIcon /> },
  { href: "/stock", label: "Stock", icon: <BoxIcon /> },
  { href: "/sales", label: "Sales", icon: <ChartIcon /> },
  { href: "/more", label: "More", icon: <DotsIcon /> },
];

export type ShellUser = {
  name: string;
  email: string;
};

/* null = the user has no membership yet ("No workspace" state). */
export type ShellWorkspace = {
  name: string;
  roleLabel: string;
} | null;

export function AppShell({
  user,
  workspace,
  children,
}: {
  user: ShellUser;
  workspace: ShellWorkspace;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
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
        <div className="border-t border-edge px-3 py-3">
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
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold text-ink">
                {workspace ? workspace.name : "No workspace"}
              </div>
              <div className="truncate text-xs text-ink-muted">
                {workspace ? workspace.roleLabel : "Ask an admin for an invite"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              aria-label="Notifications"
              className={cn(
                "relative grid size-9 place-items-center rounded-md border border-edge bg-surface text-ink-secondary transition-colors",
                "outline-accent hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2",
              )}
            >
              <BellIcon className="size-4.5" />
              <span className="absolute top-2 right-2 size-1.5 rounded-full bg-negative" />
            </button>
            <ProfileMenu
              name={user.name}
              email={user.email}
              roleLabel={workspace ? workspace.roleLabel : "No workspace"}
            />
          </div>
        </header>

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
  );
}
