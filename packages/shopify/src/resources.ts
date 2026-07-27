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
  price?: string;
  inventoryItem?: { id?: string; unitCost?: { amount?: string } };
};

export type ShopifyProductNode = {
  id: string;
  title?: string;
  vendor?: string;
  productType?: string;
  createdAt?: string; // product-age signal (dead-stock: new vs old dud)
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

/** ACTIVE products with first variant + featured image. `sinceIso` narrows to
 *  `updated_at >=`; null pulls the full catalog (first sync). */
export async function fetchProducts(client: ShopifyClient, sinceIso: string | null): Promise<ShopifyProductNode[]> {
  const q = sinceIso ? `updated_at:>=${sinceIso} status:active` : "status:active";
  return pageAll<ShopifyProductNode>(
    client,
    (after) => ({
      query: `query($after: String, $q: String!) {
        products(first: ${PAGE}, after: $after, query: $q) {
          edges { node {
            id title vendor productType createdAt isGiftCard
            featuredImage { url }
            variants(first: 1) { edges { node { id sku price inventoryItem { id unitCost { amount } } } } }
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
      })),
      pageInfo: d.products.pageInfo,
    })
  );
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
