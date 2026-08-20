import type { Role } from "@wezesha/db";

/**
 * Tour step definitions for the shell. `target` lists data-tour keys in
 * preference order — the engine highlights the first visible match — a
 * rail item on desktop, or the drawer button that holds it on mobile — and drops
 * the step when none is visible. Screens extend the tour by adding data-tour attributes to their
 * own elements and steps here.
 */
export type TourStep = {
  key: string;
  target: readonly string[];
  title: string;
  body: string;
};

/**
 * Route each step lives on, keyed by step.key. The engine navigates here before
 * showing the step, so the tour walks THROUGH the pages instead of only pointing
 * at the sidebar from Today. Steps that target shell-persistent controls
 * (workspace switcher, theme, profile) are omitted — they show on the current
 * page, no navigation needed.
 */
export const STEP_ROUTES: Record<string, string> = {
  today: "/today",
  "today-metrics": "/today",
  "today-run-forecast": "/today",
  "today-reorder": "/today",
  plan: "/plan",
  orders: "/orders",
  inventory: "/inventory",
  products: "/products",
  sales: "/sales",
  "sales-overview": "/sales",
  insights: "/insights",
  settings: "/settings",
};

/**
 * Where the engine should send the browser for a step, or null to stay put.
 *
 * Each step gets ONE navigation, when it becomes the current step. The engine
 * used to re-decide this on every pathname change, which meant a person who
 * clicked a sidebar link mid-tour was pulled straight back to the step's page —
 * the tour held the app hostage until it was skipped. Their navigation wins now;
 * the spotlight follows, because every step targets something the shell keeps on
 * screen anyway.
 */
export function routeForStep(
  step: Pick<TourStep, "key"> | null,
  pathname: string,
  navigatedForKey: string | null,
): string | null {
  if (!step) return null;
  if (navigatedForKey === step.key) return null;
  const route = STEP_ROUTES[step.key];
  return route && route !== pathname ? route : null;
}

const step = (
  key: string,
  target: readonly string[],
  title: string,
  body: string,
): TourStep => ({ key, target, title, body });

const today = step(
  "today",
  ["nav-today"],
  "Start your day here",
  "The dashboard is your daily brief: what needs restocking, what's arriving, and what to act on first.",
);

// ── Screen-level steps ───────────────────────────────────────────────────────
// These target elements inside Today/Stock/Sales; the engine keeps only the
// steps whose target is on the current screen. Cost-flavoured variants exist
// where the copy would otherwise point a money-blind MEMBER at figures the
// screen masks for them.

const todayMetrics = step(
  "today-metrics",
  ["today-metrics"],
  "Your morning numbers",
  "Revenue, tracked products, stockouts, and dead stock — the day's health at a glance.",
);

const todayMetricsCosts = step(
  "today-metrics",
  ["today-metrics"],
  "Your morning numbers",
  "Revenue, tracked products, stockouts, and the cash tied up in dead stock — the day's health at a glance.",
);

const todayRunForecast = step(
  "today-run-forecast",
  ["today-run-forecast"],
  "Run the forecast",
  "Recomputes stockout risk and recommended order quantities from the latest sales and stock levels.",
);

const todayReorder = step(
  "today-reorder",
  ["today-reorder"],
  "What to reorder",
  "The forecast's most urgent products, ranked — days of cover left and how many units to order.",
);

const todayReorderCosts = step(
  "today-reorder",
  ["today-reorder"],
  "What to reorder",
  "The forecast's most urgent products, ranked — days of cover left, units to order, and what each order will cost.",
);

const salesOverview = step(
  "sales-overview",
  ["sales-overview"],
  "Sales at a glance",
  "The trailing 30 days: revenue, units sold, and the daily average across every channel.",
);

const plan = step(
  "plan",
  ["nav-plan"],
  "Plan your restock",
  "The Restock Planner builds the buy list — forecast demand, then decide what to order and when.",
);

const orders = step(
  "orders",
  ["nav-orders", "nav-menu"],
  "Track orders",
  "Purchase orders live here, from draft to received.",
);

const inventory = step(
  "inventory",
  ["nav-inventory"],
  "Inventory",
  "Inventory shows what each branch is holding and how long it lasts at that branch's own selling rate.",
);

const products = step(
  "products",
  ["nav-products"],
  "Products",
  "Products is every item you sell, and whether its cost, supplier and SKU are sound enough to buy on.",
);

const sales = step(
  "sales",
  ["nav-sales"],
  "Sales data",
  "Sales shows what's selling and how quickly.",
);

const salesCosts = step(
  "sales",
  ["nav-sales"],
  "Sales data",
  "Sales shows what's selling and how quickly — with costs and margins, it's where the money story lives.",
);

const insights = step(
  "insights",
  ["nav-insights", "nav-menu"],
  "Reports",
  "Which shelves are empty, how much cash is asleep in stock, and whether the forecast has been right.",
);

const settings = step(
  "settings",
  ["nav-settings", "nav-menu"],
  "Run your workspace",
  "Settings is where you invite teammates, set roles, and manage the workspace.",
);

const workspaces = step(
  "workspaces",
  ["workspace-switcher"],
  "Switch workspaces",
  "Part of more than one business? Jump between workspaces here.",
);

const theme = step(
  "theme",
  ["theme-toggle"],
  "Light or dark",
  "Toggle the theme any time — your choice sticks on this device.",
);

const profile = step(
  "profile",
  ["profile-menu"],
  "Your account",
  "Profile, settings, and sign out — and you can replay this tour from here.",
);

/** OWNER/ADMIN get the full walkthrough; MEMBER a shorter operational set with
 *  cost-related copy dropped (their preset lacks view_costs, and the screens
 *  mask every KES cost figure for them).
 *
 *  `canOpenInsights` drops the Insights step for a workspace whose plan locks
 *  that screen. Without it the welcome tour walks a brand-new owner — every
 *  self-serve workspace starts on the entry tier — onto a page they cannot open,
 *  describing features they cannot use. The nav entry is always rendered, so the
 *  engine's own "is the target visible" filter cannot catch this one. */
export function tourStepsForRole(role: Role, canOpenInsights = true): TourStep[] {
  if (role === "MEMBER") {
    return [
      today,
      todayMetrics,
      todayRunForecast,
      todayReorder,
      plan,
      inventory,
      products,
      sales,
      salesOverview,
      theme,
      profile,
    ];
  }
  return [
    today,
    todayMetricsCosts,
    todayRunForecast,
    todayReorderCosts,
    plan,
    orders,
    inventory,
    products,
    salesCosts,
    salesOverview,
    ...(canOpenInsights ? [insights] : []),
    settings,
    workspaces,
    theme,
    profile,
  ];
}
