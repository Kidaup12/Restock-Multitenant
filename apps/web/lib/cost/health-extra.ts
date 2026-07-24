import { resolveCost, type StoredCost } from "./resolve";

/**
 * Extra catalogue-health signals this slice owns, complementing the facet health
 * flags (lib/facets/health.ts, consumed read-only). Kept OUT of the shared facet
 * `HealthFlag` enum so that module is untouched:
 *
 *   suspect_cost · a cost IS present but sits at or above the selling price
 *                  (zero-margin / bad data). The missing/zero case is already the
 *                  facet `missing_cost` flag, so the two never double-count.
 *   not_for_sale · owner-marked tester/display/damaged — visible in the
 *                  catalogue, out of sellable stock and its own filter chip.
 */

export type ExtraHealthFlag = "suspect_cost" | "not_for_sale";

export const EXTRA_HEALTH_LABELS: Record<ExtraHealthFlag, string> = {
  suspect_cost: "Suspect cost",
  not_for_sale: "Not for sale",
};

/** Present-but-suspect cost: fires only for a real cost >= price, so it is
 *  disjoint from the facet `missing_cost` flag (which owns cost <= 0). */
export function suspectCostPresent(p: StoredCost): boolean {
  return p.costKes > 0 && resolveCost(p).suspectReason === "cost-ge-price";
}
