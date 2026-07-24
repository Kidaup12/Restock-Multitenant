import type { AbcCategory } from "@wezesha/forecast";
import type { HealthFlag } from "./health";
import type { SpeedBand } from "./speed-band";

/**
 * The metadata facets (spec "Metrics & metadata"). Each has ONE defined source,
 * resolving the old "two category concepts" debt:
 *   brand         · Shopify vendor
 *   productType   · Shopify productType
 *   category      · owner-defined customCategory (seeded from productType)
 *   supplier      · assignment (Supplier.name)
 *   supplierGroup · optional owner label on a supplier (owned by the suppliers
 *                   stream; read defensively — absent until that column lands)
 *   speedBand     · derived from lead time
 *   abc           · forecast class
 *   health        · computed data-quality / lifecycle flags
 *
 * Options are ALWAYS derived from what the catalogue actually contains — never a
 * hard-coded list (spec §7).
 */
export type FacetKey =
  | "brand"
  | "productType"
  | "category"
  | "supplier"
  | "supplierGroup"
  | "speedBand"
  | "abc"
  | "health";

export const FACET_KEYS: readonly FacetKey[] = [
  "brand",
  "productType",
  "category",
  "supplier",
  "supplierGroup",
  "speedBand",
  "abc",
  "health",
];

export const FACET_LABELS: Record<FacetKey, string> = {
  brand: "Brand",
  productType: "Product type",
  category: "Category",
  supplier: "Supplier",
  supplierGroup: "Supplier group",
  speedBand: "Speed",
  abc: "ABC class",
  health: "Health",
};

/** Sentinel option value for products with no value on a single-value facet
 *  (no supplier, uncategorised, no lead-time band). Lets an owner filter TO the
 *  gap. Never collides with a real value. */
export const NONE_VALUE = "__none__";

/** One product projected onto every facet dimension. Single-value facets hold
 *  the value or null; health is multi-valued. */
export type FacetItem = {
  productId: string;
  brand: string | null;
  productType: string | null;
  category: string | null;
  supplier: string | null;
  supplierGroup: string | null;
  speedBand: SpeedBand | null;
  abc: AbcCategory | null;
  health: HealthFlag[];
};

export type FacetOption = { value: string; label: string; count: number };
export type FacetOptions = Record<FacetKey, FacetOption[]>;

/** Active filter selection: for each facet, the chosen values (OR within a
 *  facet). Facets not present impose no constraint. */
export type FacetSelection = Partial<Record<FacetKey, string[]>>;
