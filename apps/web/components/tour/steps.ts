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

/** OWNER/ADMIN get the full walkthrough; MEMBER a shorter operational set. */
export function tourStepsForRole(role: Role): TourStep[] {
  if (role === "MEMBER") {
    return [today, plan, stock, sales, theme, profile];
  }
  return [
    today,
    plan,
    orders,
    stock,
    salesCosts,
    insights,
    settings,
    workspaces,
    theme,
    profile,
  ];
}
