import { plannableReason } from "@wezesha/forecast";

/**
 * The per-product COST PRIORITY CHAIN and the suspect-cost rule (spec §2 "Where
 * cost comes from" + §4 Costs). One place decides which cost a product uses, what
 * to label its source, and whether that cost can be trusted for money math.
 *
 * Priority (each tier's value is only "real" when it is a positive number — a
 * zero is treated as MISSING, never written over a real cost):
 *   1. manual  — inline edit / CSV upload: an explicit owner override that wins
 *                and sticks (pinned until cleared back to "use synced cost").
 *   2. qb      — QuickBooks, if connected. SEAM: not built yet, so callers pass
 *                qbCostKes: null; the tier stays wired so QB is a one-line add.
 *   3. shopify — Shopify inventoryItem.unitCost.
 *   4. missing — nothing usable → held off the buy list, no money metrics.
 *
 * The stored model collapses the winning tier into (costKes, costSource) at WRITE
 * time (the sync guard already refuses to overwrite a manual pin), so the app
 * reads a product with one cost + one source label. `resolveCost` classifies that
 * stored shape; `resolveCostChain` is the pure priority function the write path
 * (and a future QB sync) run over all three candidates.
 */

export type CostSource = "manual" | "qb" | "shopify" | "missing";

/** A candidate is usable only when it is a finite, strictly positive number. */
function realCost(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export type CostCandidates = {
  /** Owner pin (inline edit / CSV). */
  manualCostKes?: number | null;
  /** QuickBooks match — always null until the QB tier is built. */
  qbCostKes?: number | null;
  /** Shopify unit cost read during reconcile. */
  shopifyCostKes?: number | null;
};

export type ResolvedCost = { costKes: number; source: CostSource };

/**
 * The pure priority chain: manual > qb > shopify > missing, with zero-as-missing
 * applied to every tier. This is the write-time resolver and the QB seam — pass
 * all three candidates and it picks the winner deterministically.
 */
export function resolveCostChain(c: CostCandidates): ResolvedCost {
  const manual = realCost(c.manualCostKes);
  if (manual != null) return { costKes: manual, source: "manual" };
  const qb = realCost(c.qbCostKes);
  if (qb != null) return { costKes: qb, source: "qb" };
  const shopify = realCost(c.shopifyCostKes);
  if (shopify != null) return { costKes: shopify, source: "shopify" };
  return { costKes: 0, source: "missing" };
}

/** The stored fields the read-time classifier needs. */
export type StoredCost = {
  costKes: number;
  costSource: string | null;
  priceKes: number;
};

/** Why a cost can't be trusted for money math. */
export type SuspectReason = "missing" | "cost-ge-price" | null;

export type CostClassification = {
  /** Effective cost — the stored cost, or 0 when it resolves to missing. */
  costKes: number;
  /** The tier to show in the UI, with zero-as-missing applied: a row whose
   *  stored cost is <= 0 reads "missing" whatever its label says. */
  source: CostSource;
  /** Suspect = missing, zero, or cost >= selling price (spec §2). Drives the
   *  "missing/suspect cost" health chip and the top-earners exclusion. */
  isSuspect: boolean;
  suspectReason: SuspectReason;
  /**
   * Held off the buy list. Delegates to the forecast engine's `plannableReason`
   * so this is EXACTLY the rule the budget planner already enforces (missing
   * cost, missing price, or cost > price). Note the deliberate knife-edge: a
   * product priced exactly at cost is `isSuspect` (zero margin — the catalogue
   * flags it) but not `heldOffBuyList` (the engine reorders at break-even, never
   * at a loss). Aligning that exact-equality boundary would need a change in the
   * forecast engine, which this slice does not own.
   */
  heldOffBuyList: boolean;
};

/**
 * Classify a product's stored cost: the effective cost, the source label to
 * show, whether it is suspect, and whether it is held off the buy list.
 */
export function resolveCost(p: StoredCost): CostClassification {
  const cost = Number.isFinite(p.costKes) ? p.costKes : 0;
  const hasReal = cost > 0;
  const label = p.costSource;

  const source: CostSource = !hasReal
    ? "missing"
    : label === "manual" || label === "qb" || label === "shopify"
      ? label
      : // A real cost should always carry a source (sync + manual writes both set
        // one); a legacy/blank label falls back to the baseline tier.
        "shopify";

  const suspectReason: SuspectReason = !hasReal
    ? "missing"
    : p.priceKes > 0 && cost >= p.priceKes
      ? "cost-ge-price"
      : null;

  return {
    costKes: hasReal ? cost : 0,
    source,
    isSuspect: suspectReason != null,
    suspectReason,
    heldOffBuyList: plannableReason({ costKes: cost, priceKes: p.priceKes }) !== "ok",
  };
}

/** True when a product's cost can't be trusted (the spec suspect rule). */
export function isSuspectCost(p: StoredCost): boolean {
  return resolveCost(p).isSuspect;
}

/**
 * Drop suspect-cost products from a list — the sanctioned way for the buy list
 * and top-earners to exclude them without recomputing the rule. The buy list is
 * already gated by the engine's `plannableReason`; a revenue-only top-earners
 * list (no margin) has no cost-trust issue today, so this helper is the seam for
 * a future profit-ranked view to adopt.
 */
export function excludeSuspectCost<T extends StoredCost>(rows: T[]): T[] {
  return rows.filter((r) => !isSuspectCost(r));
}
