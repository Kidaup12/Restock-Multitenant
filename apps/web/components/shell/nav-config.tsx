import {
  ArchiveIcon,
  BanknoteIcon,
  BoxIcon,
  BulbIcon,
  CalendarIcon,
  ChartIcon,
  ClipboardIcon,
  HelpIcon,
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

/**
 * The rail's four groups, in order. Eleven flat entries is a list to be read
 * rather than scanned; grouped, the reader finds the one they want by deciding
 * which *kind* of thing it is first.
 *
 * The grouping follows the job, not the schema: BUY is the replenishment cycle
 * (decide, order, receive), STOCK is where things are right now, CATALOGUE is
 * reference data you set up and revisit occasionally, ACCOUNT is everything you
 * read or configure rather than act on.
 */
export const NAV_SECTIONS = [
  { key: "buy", label: "Buy" },
  { key: "stock", label: "Stock" },
  { key: "catalogue", label: "Catalogue" },
  { key: "account", label: "Account" },
] as const;

export type NavSectionKey = (typeof NAV_SECTIONS)[number]["key"];

export type NavDestination = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /* data-tour key so the interactive tour can spotlight this entry. */
  tourKey: string;
  /* Which rail group this sits under. Omitted for the one destination that
   * leads the rail on its own — the morning briefing needs no heading. */
  section?: NavSectionKey;
  /* Permission the page needs before it shows anything useful. Set it only
   * where the destination is a dead end without it — a screen that merely masks
   * money or hides an edit button is still worth reaching. */
  permission?: PermissionKey;
};

/**
 * The single source of truth for the shell's primary destinations, in nav order.
 * Both surfaces derive from this list — through navFor, so the same entries are
 * dropped everywhere — and no entry is reachable on one and orphaned on the
 * other: the desktop rail and the mobile drawer render the same groups from the
 * same call, so there is no overflow list to keep in step.
 */
export const NAV_DESTINATIONS: NavDestination[] = [
  // Leads the rail alone: the morning briefing is where the day starts, and a
  // heading above a single entry is noise.
  { href: "/today", label: "Dashboard", icon: <HomeIcon />, tourKey: "nav-today" },

  { href: "/plan", label: "Restock Planner", icon: <CalendarIcon />, tourKey: "nav-plan", section: "buy" },
  { href: "/orders", label: "Orders", icon: <ClipboardIcon />, tourKey: "nav-orders", section: "buy" },
  { href: "/receiving", label: "Receiving", icon: <InboxIcon />, tourKey: "nav-receiving", section: "buy" },

  { href: "/inventory", label: "Inventory", icon: <ArchiveIcon />, tourKey: "nav-inventory", section: "stock" },
  {
    href: "/transfers",
    label: "Transfers",
    icon: <LayersIcon />,
    tourKey: "nav-transfers",
    section: "stock",
  },

  { href: "/products", label: "Products", icon: <BoxIcon />, tourKey: "nav-products", section: "catalogue" },
  {
    href: "/suppliers",
    label: "Suppliers",
    icon: <InboxIcon />,
    tourKey: "nav-suppliers",
    section: "catalogue",
  },
  {
    href: "/costs",
    label: "Costs",
    icon: <BanknoteIcon />,
    tourKey: "nav-costs",
    section: "catalogue",
    permission: "view_costs",
  },

  { href: "/sales", label: "Sales data", icon: <ChartIcon />, tourKey: "nav-sales", section: "account" },
  { href: "/insights", label: "Reports", icon: <BulbIcon />, tourKey: "nav-insights", section: "account" },
  {
    href: "/activity",
    label: "Activity log",
    icon: <ClipboardIcon />,
    tourKey: "nav-activity",
    section: "account",
  },
  {
    // Below Settings deliberately: someone reaches for "how does this work?"
    // after they have looked around, not before, and it is the one entry here
    // a shop stops needing.
    href: "/getting-started",
    label: "How it works",
    icon: <HelpIcon />,
    tourKey: "nav-getting-started",
    section: "account",
  },
  { href: "/settings", label: "Settings", icon: <GearIcon />, tourKey: "nav-settings", section: "account" },
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

/**
 * The caller's destinations grouped for the rail: the unsectioned lead entry,
 * then each section in order with the entries it still has.
 *
 * A section whose every entry was filtered out returns no group at all, so a
 * member without cost access never sees a "Catalogue" heading with one item
 * under it, and never an empty heading.
 */
export function navSectionsFor(membership: PermissionSource | null): {
  lead: NavDestination[];
  sections: { key: NavSectionKey; label: string; items: NavDestination[] }[];
} {
  const allowed = navFor(membership);
  return {
    lead: allowed.filter((d) => !d.section),
    sections: NAV_SECTIONS.map((s) => ({
      key: s.key,
      label: s.label,
      items: allowed.filter((d) => d.section === s.key),
    })).filter((s) => s.items.length > 0),
  };
}
