import { NONE_VALUE, type FacetItem, type FacetKey, type FacetSelection } from "./types";

/**
 * The reusable facet-filter predicate: AND across facets, OR within a facet.
 * A product passes when, for every facet with a non-empty selection, it carries
 * one of the selected values (health matches if ANY selected flag is present).
 * A single-value facet with no value on the product matches only the "none"
 * sentinel. Powers filtering, planner scoping, and saved segments.
 */
export function matchesFacets(item: FacetItem, selection: FacetSelection): boolean {
  for (const key of Object.keys(selection) as FacetKey[]) {
    const chosen = selection[key];
    if (!chosen || chosen.length === 0) continue;
    if (!facetMatches(item, key, chosen)) return false;
  }
  return true;
}

function facetMatches(item: FacetItem, key: FacetKey, chosen: string[]): boolean {
  if (key === "health") {
    return item.health.some((flag) => chosen.includes(flag));
  }
  const value = singleValue(item, key) ?? NONE_VALUE;
  return chosen.includes(value);
}

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

/** Convenience: filter a list of items by a selection. */
export function filterByFacets<T extends FacetItem>(items: T[], selection: FacetSelection): T[] {
  return items.filter((item) => matchesFacets(item, selection));
}
