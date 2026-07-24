import { NEW_PRODUCT_DAYS } from "@wezesha/forecast";

/**
 * Health flags — the computed facet (spec): the data-quality and lifecycle
 * chips an owner filters by. Each flag is derived, never stored, so it always
 * reflects the current catalogue.
 *
 *   missing_cost · no unit cost → held off the buy list, no money metrics
 *   no_supplier  · no supplier linked → no lead time, no PO grouping
 *   no_sku       · blank SKU → can't match POS / dedupe
 *   dup_sku      · SKU shared with another product → ambiguous matching
 *   negative     · oversold (sellable on-hand < 0)
 *   new          · created inside the new-product window → too new to judge
 *   dead         · has stock but no run rate (not selling) and not new
 */

export type HealthFlag =
  | "missing_cost"
  | "no_supplier"
  | "no_sku"
  | "dup_sku"
  | "negative"
  | "new"
  | "dead";

export const HEALTH_FLAGS: readonly HealthFlag[] = [
  "missing_cost",
  "no_supplier",
  "no_sku",
  "dup_sku",
  "negative",
  "new",
  "dead",
];

export const HEALTH_FLAG_LABELS: Record<HealthFlag, string> = {
  missing_cost: "Missing cost",
  no_supplier: "No supplier",
  no_sku: "No SKU",
  dup_sku: "Duplicate SKU",
  negative: "Negative stock",
  new: "New",
  dead: "Dead stock",
};

/** Run rate at or below this counts as "not selling" for the dead flag —
 *  matches the engine's zero-rate threshold in daysOfStockRemaining. */
const DEAD_RATE_EPSILON = 0.0001;

export type HealthInput = {
  sku: string | null;
  costKes: number;
  supplierId: string | null;
  sellableOnHand: number;
  runRate: number;
  createdAt: Date | null;
  /** True when this SKU appears on more than one product in the catalogue. */
  isDuplicateSku: boolean;
};

export function healthFlagsFor(p: HealthInput, asOf: Date = new Date()): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const isNew = p.createdAt != null && asOf.getTime() - p.createdAt.getTime() < NEW_PRODUCT_DAYS * 86_400_000;

  if (p.costKes <= 0) flags.push("missing_cost");
  if (!p.supplierId) flags.push("no_supplier");
  if (!p.sku || p.sku.trim() === "") flags.push("no_sku");
  else if (p.isDuplicateSku) flags.push("dup_sku");
  if (p.sellableOnHand < 0) flags.push("negative");
  if (isNew) flags.push("new");
  if (!isNew && p.sellableOnHand > 0 && p.runRate <= DEAD_RATE_EPSILON) flags.push("dead");

  return flags;
}

/** SKUs that appear on more than one product — the dup_sku source. */
export function duplicateSkus(skus: Array<string | null>): Set<string> {
  const seen = new Map<string, number>();
  for (const raw of skus) {
    const sku = raw?.trim();
    if (!sku) continue;
    seen.set(sku, (seen.get(sku) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [sku, n] of seen) if (n > 1) dups.add(sku);
  return dups;
}
