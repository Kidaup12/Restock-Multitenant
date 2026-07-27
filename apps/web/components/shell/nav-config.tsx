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

export type NavDestination = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /* data-tour key so the interactive tour can spotlight this entry. */
  tourKey: string;
};

/**
 * The single source of truth for the shell's primary destinations, in nav
 * order. Every surface derives from this list so an entry can't be reachable
 * on one and orphaned on another:
 *  - the desktop sidebar shows all of them;
 *  - the mobile tab bar promotes TAB_BAR_HREFS;
 *  - the mobile "More" page carries the rest.
 */
export const NAV_DESTINATIONS: NavDestination[] = [
  { href: "/today", label: "Today", icon: <HomeIcon />, tourKey: "nav-today" },
  { href: "/plan", label: "Plan", icon: <CalendarIcon />, tourKey: "nav-plan" },
  { href: "/orders", label: "Orders", icon: <ClipboardIcon />, tourKey: "nav-orders" },
  { href: "/stock", label: "Stock", icon: <BoxIcon />, tourKey: "nav-stock" },
  { href: "/transfers", label: "Transfers", icon: <LayersIcon />, tourKey: "nav-transfers" },
  { href: "/costs", label: "Costs", icon: <BanknoteIcon />, tourKey: "nav-costs" },
  { href: "/suppliers", label: "Suppliers", icon: <InboxIcon />, tourKey: "nav-suppliers" },
  { href: "/sales", label: "Sales data", icon: <ChartIcon />, tourKey: "nav-sales" },
  { href: "/insights", label: "Insights", icon: <BulbIcon />, tourKey: "nav-insights" },
  { href: "/settings", label: "Settings", icon: <GearIcon />, tourKey: "nav-settings" },
];

/* Destinations promoted to the mobile bottom tab bar, in tab order. Everything
 * else falls to the "More" overflow. */
export const TAB_BAR_HREFS: readonly string[] = ["/today", "/plan", "/stock", "/sales"];

/* Shorter labels for the tab bar where the sidebar label doesn't fit. */
export const TAB_BAR_LABEL: Record<string, string> = {
  "/sales": "Sales",
};
