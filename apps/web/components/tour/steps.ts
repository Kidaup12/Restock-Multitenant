import type { Role } from "@wezesha/db";

/**
 * Tour step definitions for the shell. `target` lists data-tour keys in
 * preference order — the engine highlights the first visible match (a sidebar
 * item on desktop, its tab-bar twin on mobile) and drops the step when none
 * is visible. Screens extend the tour by adding data-tour attributes to their
 * own elements and steps here.
 */
export type TourStep = {
  key: string;
  target: readonly string[];
  title: string;
  body: string;
};

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
  "Today is the daily brief: what needs restocking, what's arriving, and what to act on first.",
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

const stockTabs = step(
  "stock-tabs",
  ["stock-tabs"],
  "Two views of stock",
  "Flip between the full product catalogue and per-location holdings.",
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
  "Plan ahead",
  "Plan builds the buy list — forecast demand, then decide what to order and when.",
);

const orders = step(
  "orders",
  ["nav-orders", "nav-more"],
  "Track orders",
  "Purchase orders live here, from draft to received.",
);

const stock = step(
  "stock",
  ["nav-stock"],
  "Watch your stock",
  "Stock shows on-hand levels across locations, with items running low on top.",
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
  ["nav-insights", "nav-more"],
  "Insights",
  "Trends, dead stock, and forecast health at a glance.",
);

const settings = step(
  "settings",
  ["nav-settings", "nav-more"],
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
 *  mask every KES cost figure for them). */
export function tourStepsForRole(role: Role): TourStep[] {
  if (role === "MEMBER") {
    return [
      today,
      todayMetrics,
      todayRunForecast,
      todayReorder,
      plan,
      stock,
      stockTabs,
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
    stock,
    stockTabs,
    salesCosts,
    salesOverview,
    insights,
    settings,
    workspaces,
    theme,
    profile,
  ];
}
