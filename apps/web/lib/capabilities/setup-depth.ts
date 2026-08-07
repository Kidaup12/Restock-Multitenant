import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";

/**
 * Capability gate 1 — setup depth. How much of what the product needs is
 * actually present, as a 0–3 level plus a per-signal breakdown. The app delivers
 * value from Shopify alone (Level 0) and unlocks more as data arrives; a missing
 * input subtracts a capability, it never blocks the app.
 *
 *   L0  Shopify connected + products          forecast, buy list, stockouts
 *   L1  + costs (trusted for the revenue       money: margin, cash tied up,
 *        that matters)                         budgets, dead-stock value
 *   L2  + suppliers assigned                   PO grouping, email PO, scorecards
 *   L3  + POS feed or a 2nd selling location   blended run rate, transfers
 *
 * The decision is split from the read so the level logic is unit-testable with
 * injected counts: `computeSetupSignals` / `decideSetupLevel` are pure;
 * `setupDepth(tenantId)` does the RLS-scoped reads and calls them.
 */

const DAY_MS = 86_400_000;

/** Cost is "trusted" for at least this share of the money that matters
 *  (30-day revenue, or product count when there are no sales yet) → L1. */
export const COST_COVERAGE_THRESHOLD = 0.5;
/** Suppliers assigned to at least this share of active products → L2. */
export const SUPPLIER_COVERAGE_THRESHOLD = 0.5;

export type SetupSignal = "shopify" | "costs" | "suppliers" | "posOrMultiLocation";

export type SetupSignals = Record<SetupSignal, boolean>;

export type SetupLevel = 0 | 1 | 2 | 3;

export type SetupUnlock = {
  /** The signal that lifts the tenant to the next level. */
  signal: SetupSignal;
  /** Short imperative for the nudge ("Add product costs"). */
  title: string;
  /** One line on why it helps — a nudge names its value, never a bare wall. */
  detail: string;
};

export type SetupDepth = {
  level: SetupLevel;
  signals: SetupSignals;
  /** What unlocks the next level, or null once everything is on. */
  nextUnlock: SetupUnlock | null;
  /**
   * Locations whose role we GUESSED from their name and nobody has confirmed.
   *
   * Deliberately not a rung on the ladder: the rungs unlock capabilities, and
   * this unlocks nothing — it is a correctness check the shop alone can settle.
   * It matters because the role decides which stock counts as sellable
   * (`Product.currentStock` is the branch-only rollup), so a warehouse guessed
   * from a name like "Industrial Area" hides that stock from the forecast, and
   * a shop guessed the other way sells stock it cannot reach. Every location on
   * every live workspace is currently an unconfirmed guess.
   */
  locationsToConfirm: number;
};

/** Pre-aggregated inputs the pure signal logic reads. */
export type SetupInput = {
  /** A live ShopifyConnection row (installed, not uninstalled). */
  shopifyConnected: boolean;
  /** Active products in the catalogue. */
  activeProducts: number;
  /** Active products carrying a trusted cost (a costSource + a non-zero cost). */
  trustedCostProducts: number;
  /** 30-day revenue across active products. */
  revenue30dTotal: number;
  /** …the slice of it earned by products that have a trusted cost. */
  revenue30dTrustedCost: number;
  /** Active products with a supplier assigned. */
  suppliedProducts: number;
  /** A POS feed is configured for the tenant. */
  posFeedConfigured: boolean;
  /** Active selling locations (branch-role); >1 = multi-location. */
  sellableLocations: number;
};

/** Cost coverage weighted by revenue — a missing cost on a top seller hurts more
 *  than on ten dead items. Falls back to product count when the shop has no
 *  sales yet, so a fresh catalogue still gets an honest number. */
export function costCoverageRatio(input: SetupInput): number {
  if (input.revenue30dTotal > 0) {
    return input.revenue30dTrustedCost / input.revenue30dTotal;
  }
  if (input.activeProducts > 0) return input.trustedCostProducts / input.activeProducts;
  return 0;
}

/** The four independent signals from the raw data present. */
export function computeSetupSignals(input: SetupInput): SetupSignals {
  const supplierRatio =
    input.activeProducts > 0 ? input.suppliedProducts / input.activeProducts : 0;
  return {
    shopify: input.shopifyConnected && input.activeProducts > 0,
    costs: costCoverageRatio(input) > COST_COVERAGE_THRESHOLD,
    suppliers: supplierRatio > SUPPLIER_COVERAGE_THRESHOLD,
    posOrMultiLocation: input.posFeedConfigured || input.sellableLocations > 1,
  };
}

const LADDER: SetupSignal[] = ["shopify", "costs", "suppliers", "posOrMultiLocation"];

const UNLOCKS: Record<SetupSignal, SetupUnlock> = {
  shopify: {
    signal: "shopify",
    title: "Connect Shopify",
    detail: "Sync your catalogue and sales to get a buy list from day one.",
  },
  costs: {
    signal: "costs",
    title: "Add product costs",
    detail: "Unlock margins, cash tied up, and budget planning.",
  },
  suppliers: {
    signal: "suppliers",
    title: "Assign suppliers & lead times",
    detail: "Unlock PO grouping, emailing POs, and supplier scorecards.",
  },
  posOrMultiLocation: {
    signal: "posOrMultiLocation",
    title: "Add a POS feed or a second location",
    detail: "Unlock blended run rate and moving stock between branches.",
  },
};

/**
 * The contiguous ladder: a level is reached only when every rung below it is
 * satisfied, so a shop that skipped costs but happens to have suppliers still
 * sits at L0 with "add costs" as the one nudge that matters. `nextUnlock` is the
 * first missing rung; a level-0 result whose nextUnlock is "shopify" is the
 * not-connected-yet floor.
 */
export function decideSetupLevel(signals: SetupSignals): {
  level: SetupLevel;
  nextUnlock: SetupUnlock | null;
} {
  let level: SetupLevel = 0;
  for (let i = 0; i < LADDER.length; i++) {
    const signal = LADDER[i]!;
    if (!signals[signal]) {
      return { level, nextUnlock: UNLOCKS[signal] };
    }
    level = i as SetupLevel; // shopify → 0, costs → 1, suppliers → 2, pos → 3
  }
  return { level: 3, nextUnlock: null };
}

/** Setup depth for a tenant, from the data present. RLS-scoped reads only. */
export async function setupDepth(tenantId: string): Promise<SetupDepth> {
  const db = prismaForTenant(tenantId);
  const since30 = new Date(Date.now() - 30 * DAY_MS);

  const [conn, config, locations, products, revenueRows] = await Promise.all([
    db.shopifyConnection.findFirst({ select: { uninstalledAt: true } }),
    db.tenantConfig.findFirst({ select: { posFeedUrl: true, posIngestSecretHash: true } }),
    db.location.findMany({ select: { locationType: true, roleStatus: true } }),
    db.product.findMany({
      where: { ...BUYABLE_PRODUCT_WHERE },
      select: { id: true, costSource: true, costKes: true, supplierId: true },
    }),
    db.salesHistory.groupBy({
      by: ["productId"],
      where: { date: { gte: since30 } },
      _sum: { revenueKes: true },
    }),
  ]);

  const revenueByProduct = new Map(
    revenueRows.map((r) => [r.productId, r._sum.revenueKes ?? 0]),
  );

  let trustedCostProducts = 0;
  let suppliedProducts = 0;
  let revenue30dTotal = 0;
  let revenue30dTrustedCost = 0;
  for (const p of products) {
    const trusted = p.costSource != null && p.costKes > 0;
    const revenue = revenueByProduct.get(p.id) ?? 0;
    revenue30dTotal += revenue;
    if (trusted) {
      trustedCostProducts += 1;
      revenue30dTrustedCost += revenue;
    }
    if (p.supplierId != null) suppliedProducts += 1;
  }

  // "Sells" locations only: warehouse / virtual / enroute stock is not sellable.
  // A null role is treated as a branch (schema default), so it counts.
  const sellableLocations = locations.filter(
    (l) => l.locationType == null || l.locationType === "branch",
  ).length;

  const input: SetupInput = {
    shopifyConnected: conn != null && conn.uninstalledAt == null,
    activeProducts: products.length,
    trustedCostProducts,
    revenue30dTotal,
    revenue30dTrustedCost,
    suppliedProducts,
    // Either direction counts. A shop whose till POSTS its sales is sending POS
    // data just as much as one we pull a feed from — reading only posFeedUrl
    // left the push path permanently short of this rung.
    posFeedConfigured: Boolean(config?.posFeedUrl || config?.posIngestSecretHash),
    sellableLocations,
  };

  const signals = computeSetupSignals(input);
  const { level, nextUnlock } = decideSetupLevel(signals);
  // A single location is the case that bites hardest: guessed as a warehouse,
  // NOTHING is sellable and the buy list asks the shop to reorder its whole
  // catalogue. So an unconfirmed one counts even when there is only one.
  const locationsToConfirm = locations.filter((l) => l.roleStatus !== "confirmed").length;

  return { level, signals, nextUnlock, locationsToConfirm };
}
