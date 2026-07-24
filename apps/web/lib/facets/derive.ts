import type { AbcCategory } from "@wezesha/forecast";
import {
  duplicateSkus,
  healthFlagsFor,
  HEALTH_FLAGS,
  HEALTH_FLAG_LABELS,
  type HealthFlag,
} from "./health";
import {
  speedBandFromLeadDays,
  SPEED_BANDS,
  SPEED_BAND_LABELS,
  type SpeedBand,
} from "./speed-band";
import {
  FACET_KEYS,
  NONE_VALUE,
  type FacetItem,
  type FacetKey,
  type FacetOption,
  type FacetOptions,
} from "./types";

/**
 * Facet derivation: project the catalogue onto facet dimensions, then derive
 * each facet's option list from what the rows actually contain. Pure — the data
 * getter loads rows, this turns them into filterable facets.
 */

/** The raw per-product facts a facet item is built from. Lead days is resolved
 *  by the caller (leadDaysFor) so this module stays free of Prisma shapes and
 *  the supplier-group column it does not own. */
export type FacetSourceRow = {
  productId: string;
  vendor: string | null;
  productType: string | null;
  customCategory: string | null;
  sku: string | null;
  costKes: number;
  supplierId: string | null;
  supplierName: string | null;
  /** Optional owner label on the supplier — absent until the suppliers stream
   *  adds the column; treated as null here. */
  supplierGroup?: string | null;
  leadDays: number | null;
  sellableOnHand: number;
  runRate: number;
  abc: AbcCategory | null;
  createdAt: Date | null;
};

export function buildFacetItems(rows: FacetSourceRow[], asOf: Date = new Date()): FacetItem[] {
  const dups = duplicateSkus(rows.map((r) => r.sku));
  return rows.map((r) => ({
    productId: r.productId,
    brand: r.vendor,
    productType: r.productType,
    category: r.customCategory,
    supplier: r.supplierName,
    supplierGroup: r.supplierGroup ?? null,
    speedBand: speedBandFromLeadDays(r.leadDays),
    abc: r.abc,
    health: healthFlagsFor(
      {
        sku: r.sku,
        costKes: r.costKes,
        supplierId: r.supplierId,
        sellableOnHand: r.sellableOnHand,
        runRate: r.runRate,
        createdAt: r.createdAt,
        isDuplicateSku: r.sku ? dups.has(r.sku.trim()) : false,
      },
      asOf
    ),
  }));
}

/** Fixed display order per facet; anything outside falls back to alpha. */
const ABC_ORDER = ["A", "B", "C"];
function orderIndex(key: FacetKey, value: string): number {
  if (key === "abc") return ABC_ORDER.indexOf(value);
  if (key === "speedBand") return SPEED_BANDS.indexOf(value as SpeedBand);
  if (key === "health") return HEALTH_FLAGS.indexOf(value as HealthFlag);
  return -1;
}

function labelFor(key: FacetKey, value: string): string {
  if (value === NONE_VALUE) return key === "category" ? "Uncategorised" : "None";
  if (key === "speedBand") return SPEED_BAND_LABELS[value as SpeedBand] ?? value;
  if (key === "health") return HEALTH_FLAG_LABELS[value as HealthFlag] ?? value;
  return value;
}

/** Single-value facet accessor. Health is handled separately (multi-valued). */
function singleValue(item: FacetItem, key: Exclude<FacetKey, "health">): string | null {
  switch (key) {
    case "brand":
      return item.brand;
    case "productType":
      return item.productType;
    case "category":
      return item.category;
    case "supplier":
      return item.supplier;
    case "supplierGroup":
      return item.supplierGroup;
    case "speedBand":
      return item.speedBand;
    case "abc":
      return item.abc;
  }
}

function optionsForFacet(items: FacetItem[], key: FacetKey): FacetOption[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (key === "health") {
      for (const flag of item.health) counts.set(flag, (counts.get(flag) ?? 0) + 1);
    } else {
      const value = singleValue(item, key);
      const bucket = value ?? NONE_VALUE;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: labelFor(key, value), count }))
    .sort((a, b) => {
      // NONE always last; then any fixed per-facet order; then alpha by label.
      if (a.value === NONE_VALUE) return 1;
      if (b.value === NONE_VALUE) return -1;
      const ai = orderIndex(key, a.value);
      const bi = orderIndex(key, b.value);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.label.localeCompare(b.label);
    });
}

/** Every facet's options, derived from the catalogue. Empty facets (no values
 *  present, e.g. supplierGroup before that column exists) return []. */
export function deriveFacetOptions(items: FacetItem[]): FacetOptions {
  const out = {} as FacetOptions;
  for (const key of FACET_KEYS) {
    const options = optionsForFacet(items, key);
    // Drop a facet that only ever has the "none" bucket — nothing to filter by.
    out[key] = options.length === 1 && options[0]!.value === NONE_VALUE ? [] : options;
  }
  return out;
}
