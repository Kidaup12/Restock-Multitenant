import type { ShopifyClient } from "./client";

/**
 * Cursor-paginated Admin GraphQL reads sized for incremental syncs. Every id in
 * the returned nodes is left as Shopify sends it (gid) — callers normalize via
 * numericCore() before storing or keying (see ids.ts).
 */

export type ShopifyVariantNode = {
  id?: string;
  /** Genuinely null on real variants — gift-card denominations and any product
   *  saved without one come back with no SKU at all, not an empty string. */
  sku?: string | null;
  /** The variant's option label ("Shade 03 / 50ml"). A product with no options
   *  has exactly one variant and Shopify titles it "Default Title". */
  title?: string | null;
  price?: string;
  inventoryItem?: { id?: string; unitCost?: { amount?: string } };
};

export type ShopifyProductNode = {
  id: string;
  title?: string;
  vendor?: string;
  productType?: string;
  createdAt?: string; // product-age signal (dead-stock: new vs old dud)
  /** Shopify's ProductStatus enum: "ACTIVE" | "DRAFT" | "ARCHIVED". */
  status?: string;
  /** Null while the product is published to no sales channel (Shopify calls it
   *  unlisted) — recorded, never an exclusion on its own. */
  publishedAt?: string | null;
  featuredImage?: { url?: string };
  /** Gift cards are issued, not stocked — they carry no cost and can't be
   *  reordered, so the catalogue skips them. */
  isGiftCard?: boolean;
  variants?: ShopifyVariantNode[];
};

export type ShopifyInventoryLevelNode = {
  // Includes "available", "on_hand", and "incoming" (in-transit TO this
  // location) — read the one you need by name.
  quantities?: Array<{ name: string; quantity: number }>;
  item?: { id?: string; variant?: { id?: string; product?: { id?: string } } };
};

export type ShopifyLocationNode = {
  id: string;
  name?: string;
  isActive?: boolean;
  inventoryLevels?: ShopifyInventoryLevelNode[];
};

export type ShopifyOrderNode = {
  id: string;
  name?: string;
  createdAt?: string;
  // When the sale actually happened. Differs from createdAt for imported /
  // back-dated / POS-channel orders — createdAt is just the API insertion time.
  processedAt?: string;
  /** Set when the order was cancelled — it never became a sale. */
  cancelledAt?: string | null;
  /** Returns against this order. Netted off the sale so the run rate reflects
   *  what the shop actually kept selling, not what left the counter once. */
  refunds?: Array<{
    refundLineItems?: Array<{ quantity?: number; lineItem?: { id?: string } }>;
  }>;
  lineItems?: Array<{
    id?: string;
    quantity?: number;
    sku?: string;
    product?: { id?: string };
    variant?: { id?: string };
    originalUnitPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  }>;
  // Locations that fulfilled the order — the branch(es) that shipped it. Used
  // to attribute online sales to a branch's run rate (SalesHistory.locationId).
  // Empty/absent for orders not yet fulfilled.
  fulfillments?: Array<{ location?: { id?: string } }>;
};

const PAGE = 100;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

async function pageAll<T>(
  client: ShopifyClient,
  build: (after: string | null) => { query: string; variables: Record<string, unknown> },
  extract: (data: unknown) => { nodes: T[]; pageInfo: PageInfo }
): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  // Hard ceiling to avoid an accidental infinite loop.
  for (let i = 0; i < 1000; i++) {
    const { query, variables } = build(after);
    const data = await client.graphql<unknown>(query, variables);
    const { nodes, pageInfo } = extract(data);
    out.push(...nodes);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- GraphQL edge unwrapping */

const VARIANT_FIELDS = "id sku title price inventoryItem { id unitCost { amount } }";

/** Follow a product's variants connection past the page the product query
 *  returned. Rare (a product needs more than 100 variants) but silent when
 *  wrong: the missing variants would look like SKUs the store never had. */
async function fetchRemainingVariants(
  client: ShopifyClient,
  productGid: string,
  from: string
): Promise<ShopifyVariantNode[]> {
  const out: ShopifyVariantNode[] = [];
  let after: string | null = from;
  for (let i = 0; i < 1000; i++) {
    const data: any = await client.graphql<any>(
      `query($id: ID!, $after: String) {
        product(id: $id) {
          variants(first: ${PAGE}, after: $after) {
            edges { node { ${VARIANT_FIELDS} } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: productGid, after }
    );
    const conn = data.product?.variants;
    if (!conn) break;
    out.push(...conn.edges.map((e: any) => e.node));
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * Every product — active, draft and archived — with ALL its variants and its
 * featured image. `sinceIso` narrows to `updated_at >=`; null pulls the full
 * catalog (first sync).
 *
 * Deliberately unfiltered on status: a SKU the shop drafted or archived still
 * has stock and history, and dropping it here left the catalogue silently
 * missing it. The lifecycle columns decide what the buy list will order.
 */
export async function fetchProducts(client: ShopifyClient, sinceIso: string | null): Promise<ShopifyProductNode[]> {
  const q = sinceIso ? `updated_at:>=${sinceIso}` : null;
  const nodes = await pageAll<ShopifyProductNode & { variantPage?: PageInfo }>(
    client,
    (after) => ({
      query: `query($after: String, $q: String) {
        products(first: ${PAGE}, after: $after, query: $q) {
          edges { node {
            id title vendor productType createdAt status publishedAt isGiftCard
            featuredImage { url }
            variants(first: ${PAGE}) {
              edges { node { ${VARIANT_FIELDS} } }
              pageInfo { hasNextPage endCursor }
            }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      variables: { after, q },
    }),
    (d: any) => ({
      nodes: d.products.edges.map((e: any) => ({
        ...e.node,
        variants: e.node.variants.edges.map((v: any) => v.node),
        variantPage: e.node.variants.pageInfo,
      })),
      pageInfo: d.products.pageInfo,
    })
  );

  const out: ShopifyProductNode[] = [];
  for (const { variantPage, ...node } of nodes) {
    if (variantPage?.hasNextPage && variantPage.endCursor) {
      node.variants = [
        ...(node.variants ?? []),
        ...(await fetchRemainingVariants(client, node.id, variantPage.endCursor)),
      ];
    }
    out.push(node);
  }
  return out;
}

/** Orders whose `updated_at >= sinceIso`, with line items. */
export async function fetchOrdersSince(client: ShopifyClient, sinceIso: string): Promise<ShopifyOrderNode[]> {
  return pageAll<ShopifyOrderNode>(
    client,
    (after) => ({
      query: `query($after: String, $q: String!) {
        orders(first: ${PAGE}, after: $after, query: $q) {
          edges { node {
            id name createdAt processedAt cancelledAt
            fulfillments(first: 10) { location { id } }
            refunds { refundLineItems(first: 50) { edges { node { quantity lineItem { id } } } } }
            lineItems(first: 50) { edges { node {
              id quantity sku product { id } variant { id }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
            } } }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      variables: { after, q: `updated_at:>=${sinceIso}` },
    }),
    (d: any) => ({
      nodes: d.orders.edges.map((e: any) => ({
        ...e.node,
        refunds: (e.node.refunds ?? []).map((r: any) => ({
          refundLineItems: (r.refundLineItems?.edges ?? []).map((rl: any) => rl.node),
        })),
        lineItems: e.node.lineItems.edges.map((l: any) => l.node),
      })),
      pageInfo: d.orders.pageInfo,
    })
  );
}

/** Page through ALL inventory levels for a single location (inner connection). */
async function fetchInventoryLevelsForLocation(
  client: ShopifyClient,
  locationGid: string
): Promise<ShopifyInventoryLevelNode[]> {
  const out: ShopifyInventoryLevelNode[] = [];
  let after: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const data: any = await client.graphql<any>(
      `query($id: ID!, $after: String) {
        location(id: $id) {
          inventoryLevels(first: 250, after: $after) {
            edges { node {
              quantities(names: ["available", "on_hand", "incoming"]) { name quantity }
              item { id variant { id product { id } } }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: locationGid, after }
    );
    const conn = data.location?.inventoryLevels;
    if (!conn) break;
    out.push(...conn.edges.map((e: any) => e.node));
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * All locations with their inventory levels (full refresh — inventory has no
 * cheap delta). The inner inventoryLevels connection is FULLY paginated per
 * location: a single `first: 250` caps silently and can drop most of a large
 * store's inventory. Locations are few, so the outer list is one page.
 */
export async function fetchLocationsWithInventory(client: ShopifyClient): Promise<ShopifyLocationNode[]> {
  const locations = await pageAll<{ id: string; name: string; isActive: boolean }>(
    client,
    (after) => ({
      query: `query($after: String) {
        locations(first: 50, after: $after) {
          edges { node { id name isActive } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      variables: { after },
    }),
    (d: any) => ({
      nodes: d.locations.edges.map((e: any) => e.node),
      pageInfo: d.locations.pageInfo,
    })
  );

  const result: ShopifyLocationNode[] = [];
  for (const loc of locations) {
    const inventoryLevels = await fetchInventoryLevelsForLocation(client, loc.id);
    result.push({ ...loc, inventoryLevels });
  }
  return result;
}
