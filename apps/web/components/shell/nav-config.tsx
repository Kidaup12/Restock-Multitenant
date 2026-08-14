import {
  BanknoteIcon,
  BoxIcon,
  BulbIcon,
  CalendarIcon,
  ChartIcon,
  ClipboardIcon,
  GearIcon,
  HomeIcon,
  InboxIcon,
  LayersIcon,
} from "@/components/icons";
import {
  hasPermission,
  type PermissionKey,
  type PermissionSource,
} from "@/lib/auth/permissions";

export type NavDestination = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /* data-tour key so the interactive tour can spotlight this entry. */
  tourKey: string;
  /* Permission the page needs before it shows anything useful. Set it only
   * where the destination is a dead end without it — a screen that merely masks
   * money or hides an edit button is still worth reaching. */
  permission?: PermissionKey;
};

/**
 * The single source of truth for the shell's primary destinations, in nav
 * order. Every surface derives from this list — through navFor, so the same
 * entries are dropped everywhere — and no entry is reachable on one surface
 * and orphaned on another:
 *  - the desktop sidebar shows all the caller is allowed;
 *  - the mobile tab bar promotes TAB_BAR_HREFS;
 *  - the mobile "More" page carries the rest.
 */
export const NAV_DESTINATIONS: NavDestination[] = [
  { href: "/today", label: "Today", icon: <HomeIcon />, tourKey: "nav-today" },
  { href: "/plan", label: "Plan", icon: <CalendarIcon />, tourKey: "nav-plan" },
  { href: "/orders", label: "Orders", icon: <ClipboardIcon />, tourKey: "nav-orders" },
  { href: "/stock", label: "Stock", icon: <BoxIcon />, tourKey: "nav-stock" },
  { href: "/transfers", label: "Transfers", icon: <LayersIcon />, tourKey: "nav-transfers" },
  {
    href: "/costs",
    label: "Costs",
    icon: <BanknoteIcon />,
    tourKey: "nav-costs",
    permission: "view_costs",
  },
  { href: "/suppliers", label: "Suppliers", icon: <InboxIcon />, tourKey: "nav-suppliers" },
  { href: "/sales", label: "Sales data", icon: <ChartIcon />, tourKey: "nav-sales" },
  { href: "/insights", label: "Insights", icon: <BulbIcon />, tourKey: "nav-insights" },
  { href: "/activity", label: "Activity log", icon: <ClipboardIcon />, tourKey: "nav-activity" },
  { href: "/settings", label: "Settings", icon: <GearIcon />, tourKey: "nav-settings" },
];

/**
 * The destinations this caller should be offered, in config order. Takes the
 * membership rather than the bare role so a per-member grant (or an explicit
 * empty override on an owner) decides it, the same way the pages do. Null =
 * no workspace yet, which carries no permissions.
 *
 * Permissions only — plan tier is deliberately not filtered here: a locked
 * screen on a lower plan is an upsell we want the shop to see.
 */
export function navFor(membership: PermissionSource | null): NavDestination[] {
  return NAV_DESTINATIONS.filter(
    (d) => !d.permission || (membership !== null && hasPermission(membership, d.permission)),
  );
}

/* Destinations promoted to the mobile bottom tab bar, in tab order. Everything
 * else falls to the "More" overflow. */
export const TAB_BAR_HREFS: readonly string[] = ["/today", "/plan", "/stock", "/sales"];

/* Shorter labels for the tab bar where the sidebar label doesn't fit. */
export const TAB_BAR_LABEL: Record<string, string> = {
  "/sales": "Sales",
};
