// One definition of what the shop is still selling.
//
// Before this, every surface re-invented the filter — some checked active, some
// added notForSale, the forecast checked both and the buy list checked neither
// because it read predictions that had already been filtered upstream. A SKU the
// shop archived in Shopify stayed on the buy list because nothing ever wrote the
// flag any of them read.

export const PRODUCT_STATUSES = ["active", "draft", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Statuses that mean the shop has stopped selling it. */
export const NOT_SELLING_STATUSES: ProductStatus[] = ["draft", "archived"];

export function isProductStatus(value: string): value is ProductStatus {
  return (PRODUCT_STATUSES as readonly string[]).includes(value);
}

/**
 * Prisma `where` fragment for "we would order more of this".
 *
 * Spread into a query alongside tenant scope. Deliberately NOT a filter on
 * publishedAt: an unpublished product is Shopify's "unlisted", and a shop that
 * sells over the counter and keeps Shopify as a stock ledger publishes nothing
 * at all — filtering on it would empty that shop's buy list.
 */
export const BUYABLE_PRODUCT_WHERE = {
  active: true,
  notForSale: false,
  missingFromShopifyAt: null,
  shopifyStatus: { notIn: NOT_SELLING_STATUSES },
} as const;

type LifecycleInput = {
  active: boolean;
  notForSale: boolean;
  shopifyStatus: string;
  publishedAt: Date | null;
  missingFromShopifyAt: Date | null;
};

export type ProductLifecycle =
  | "active"
  | "unlisted"
  | "draft"
  | "archived"
  | "removed"
  | "not_for_sale"
  | "deactivated";

/**
 * The single label a row carries in the catalogue, most severe first: a product
 * that is archived AND gone from the store reads as removed, because that is
 * the one the owner has to act on.
 */
export function productLifecycle(p: LifecycleInput): ProductLifecycle {
  if (p.missingFromShopifyAt) return "removed";
  if (p.shopifyStatus === "archived") return "archived";
  if (p.shopifyStatus === "draft") return "draft";
  if (p.notForSale) return "not_for_sale";
  if (!p.active) return "deactivated";
  if (!p.publishedAt) return "unlisted";
  return "active";
}

/** Whether the buy list would consider this row — mirrors BUYABLE_PRODUCT_WHERE. */
export function isBuyable(p: LifecycleInput): boolean {
  const life = productLifecycle(p);
  return life === "active" || life === "unlisted";
}

export const LIFECYCLE_LABELS: Record<ProductLifecycle, string> = {
  active: "Active",
  unlisted: "Unlisted",
  draft: "Draft",
  archived: "Archived",
  removed: "Removed from store",
  not_for_sale: "Not for sale",
  deactivated: "Deactivated",
};

/** Why a row is off the buy list, in the owner's words. null = it is on it. */
export function heldReason(p: LifecycleInput): string | null {
  switch (productLifecycle(p)) {
    case "removed":
      return "Gone from your store, so there is nothing to plan for it";
    case "archived":
      return "Archived in your store";
    case "draft":
      return "Still a draft in your store";
    case "not_for_sale":
      return "Marked not for sale";
    case "deactivated":
      return "Deactivated";
    default:
      return null;
  }
}
