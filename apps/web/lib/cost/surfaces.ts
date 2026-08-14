/**
 * The cost-bearing surfaces of the data layer, declared once.
 *
 * Money-blindness is the one isolation guarantee with nothing underneath it.
 * Tenant isolation is enforced by row-level security whatever the code does; a
 * member never seeing a cost figure is enforced only by each getter taking
 * `canViewCosts` and nulling the figures on the way out — and by somebody
 * remembering to write the test.
 *
 * `member-visibility.test.tsx` used to name the surfaces it covered in its own
 * import list, which meant a new cost-bearing screen was covered exactly when
 * its author thought to add one. This manifest inverts that: the suite DERIVES
 * the surfaces by scanning `lib/data` for exported functions that touch a cost
 * column, and compares what it finds against the list below. A new cost-bearing
 * getter is therefore red the moment it lands, and the only way to make it green
 * is to declare it here with the suite that proves it money-blind.
 *
 * What this manifest does NOT claim: that the named suite proves the surface is
 * money-blind. It records that the suite exercises the getter with the
 * money-blind wiring. Whether the assertions are the right ones is a reading
 * job, not a mechanical one.
 */

/** Directory scanned for cost-bearing getters, relative to `apps/web`. */
export const COST_SURFACE_DIR = "lib/data";

/**
 * Database columns that carry, or directly disclose, what the shop PAYS.
 *
 * `priceKes` and `revenueKes` are deliberately absent: a selling price and the
 * sales it made are visible to every role by design.
 *
 * The lint rule `cost-visibility/require-cost-gate` keeps its own copy — it is a
 * plain-JS ESLint plugin and cannot import this module — and a test compares the
 * two, so a column added to the schema cannot be taught to one and not the other.
 */
export const COST_COLUMNS = [
  "costKes",
  "lastSyncedCostKes",
  "unitCostKes",
  "lineTotalKes",
  "subtotalKes",
  // Not figures, but each answers a question about cost: where it came from,
  // whether it exists at all, whether it moved and by how much.
  "costSource",
  "costUpdatedAt",
  "costMovedPct",
  "costMovedAt",
] as const;

export type CostSurface = {
  /** Module path relative to `apps/web`, without extension. */
  module: string;
  /** The exported function. */
  getter: string;
  /** Test file (relative to `apps/web`) that exercises it money-blind. */
  provenBy: string;
};

/**
 * Every exported getter in `lib/data` that touches a cost column, and where its
 * money-blind behaviour is exercised. Ordered by module.
 *
 * Two suites carry this weight: `member-visibility` for the screens a member
 * opens, and `orders-money-blind` for the purchase-order surfaces, which are a
 * different question (a PO is a cost document by nature — the send authorises
 * the figures to leave, not the reader).
 */
export const COST_SURFACES: CostSurface[] = [
  { module: "lib/data/costs", getter: "getCostCoverage", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/costs", getter: "getCostMovedAlerts", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/insights", getter: "getInsightsOverview", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/orders", getter: "getOrderQueue", provenBy: "tests/orders-money-blind.test.ts" },
  { module: "lib/data/orders", getter: "getPurchaseOrders", provenBy: "tests/orders-money-blind.test.ts" },
  { module: "lib/data/orders", getter: "getPoDetail", provenBy: "tests/orders-money-blind.test.ts" },
  { module: "lib/data/orders", getter: "getPoDocument", provenBy: "tests/orders-money-blind.test.ts" },
  { module: "lib/data/plan-calendar", getter: "getSupplyCalendar", provenBy: "tests/plan-calendar.test.ts" },
  { module: "lib/data/plan", getter: "getBuyList", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/plan", getter: "splitByBudget", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/product-detail", getter: "getProductDetail", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/stock", getter: "getStockCatalogue", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/stock", getter: "getStockByLocation", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/today", getter: "getTodayMetrics", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/today", getter: "getReorderNeeded", provenBy: "tests/member-visibility.test.tsx" },
  { module: "lib/data/transfers", getter: "getDistributionProposal", provenBy: "tests/member-visibility.test.tsx" },
];

/** `module#getter`, the key both the manifest and the scan are compared on. */
export function surfaceKey(surface: { module: string; getter: string }): string {
  return `${surface.module}#${surface.getter}`;
}
