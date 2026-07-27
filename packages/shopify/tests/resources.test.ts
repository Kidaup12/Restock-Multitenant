import { describe, expect, it } from "vitest";
import type { ShopifyClient } from "../src/client";
import { fetchProducts } from "../src/resources";

/**
 * The product read, against a scripted GraphQL surface. What matters here is
 * what the query ASKS FOR — a status filter or a one-variant page both lose
 * SKUs silently, and the catalogue just looks like the store never had them.
 */

type Call = { query: string; variables: Record<string, unknown> };

/** A client that answers each call from `responses` in order, recording what
 *  was asked. The last response repeats if the caller keeps paging. */
function clientWith(responses: unknown[], calls: Call[] = []): { client: ShopifyClient; calls: Call[] } {
  let i = 0;
  const client: ShopifyClient = {
    shopDomain: "example-store.myshopify.com",
    graphql: async <T,>(query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables: variables ?? {} });
      return responses[Math.min(i++, responses.length - 1)] as T;
    },
  };
  return { client, calls };
}

function variantEdge(id: string, sku: string, title: string, price: string, cost?: string) {
  return {
    node: {
      id: `gid://shopify/ProductVariant/${id}`,
      sku,
      title,
      price,
      inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, unitCost: cost ? { amount: cost } : null },
    },
  };
}

function productsPage(
  edges: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null }
) {
  return { products: { edges, pageInfo } };
}

const NO_MORE = { hasNextPage: false, endCursor: null };

describe("fetchProducts", () => {
  it("does not filter on status — draft and archived products come back too", async () => {
    const { client, calls } = clientWith([
      productsPage([
        {
          node: {
            id: "gid://shopify/Product/1",
            title: "Retired Serum",
            status: "ARCHIVED",
            publishedAt: null,
            variants: { edges: [variantEdge("11", "SER-1", "Default Title", "500")], pageInfo: NO_MORE },
          },
        },
      ]),
    ]);
    const products = await fetchProducts(client, null);

    expect(calls[0]!.query).not.toMatch(/status:active/);
    expect(calls[0]!.variables.q).toBeNull(); // full catalogue: no query filter at all
    expect(products[0]).toMatchObject({ status: "ARCHIVED", publishedAt: null });
  });

  it("keeps the incremental updated_at filter and asks for the lifecycle fields", async () => {
    const { client, calls } = clientWith([productsPage([])]);
    await fetchProducts(client, "2026-07-01T00:00:00Z");

    expect(calls[0]!.variables.q).toBe("updated_at:>=2026-07-01T00:00:00Z");
    expect(calls[0]!.query).toMatch(/status publishedAt/);
  });

  it("returns every variant of a product, each with its own sku, price and cost", async () => {
    const { client } = clientWith([
      productsPage([
        {
          node: {
            id: "gid://shopify/Product/2",
            title: "Foundation",
            status: "ACTIVE",
            variants: {
              edges: [
                variantEdge("21", "FND-01", "Shade 01", "1500", "900"),
                variantEdge("22", "FND-02", "Shade 02", "1500", "950"),
                variantEdge("23", "FND-03", "Shade 03", "1600", "980"),
              ],
              pageInfo: NO_MORE,
            },
          },
        },
      ]),
    ]);
    const [product] = await fetchProducts(client, null);

    expect(product!.variants).toHaveLength(3);
    expect(product!.variants!.map((v) => v.sku)).toEqual(["FND-01", "FND-02", "FND-03"]);
    expect(product!.variants!.map((v) => v.title)).toEqual(["Shade 01", "Shade 02", "Shade 03"]);
    expect(product!.variants![2]!.inventoryItem?.unitCost?.amount).toBe("980");
  });

  it("follows the variants connection past its first page", async () => {
    const { client, calls } = clientWith([
      productsPage([
        {
          node: {
            id: "gid://shopify/Product/3",
            title: "Lipstick",
            status: "ACTIVE",
            variants: {
              edges: [variantEdge("31", "LIP-01", "Red", "800")],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
      ]),
      {
        product: {
          variants: {
            edges: [variantEdge("32", "LIP-02", "Pink", "800")],
            pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
          },
        },
      },
      {
        product: {
          variants: { edges: [variantEdge("33", "LIP-03", "Nude", "800")], pageInfo: NO_MORE },
        },
      },
    ]);
    const [product] = await fetchProducts(client, null);

    expect(product!.variants!.map((v) => v.sku)).toEqual(["LIP-01", "LIP-02", "LIP-03"]);
    // Each follow-up resumes from the cursor the previous page ended on.
    expect(calls[1]!.variables).toMatchObject({ id: "gid://shopify/Product/3", after: "cursor-1" });
    expect(calls[2]!.variables).toMatchObject({ after: "cursor-2" });
  });

  it("pages the product list itself", async () => {
    const { client } = clientWith([
      productsPage(
        [
          {
            node: {
              id: "gid://shopify/Product/4",
              title: "First",
              variants: { edges: [variantEdge("41", "A", "Default Title", "10")], pageInfo: NO_MORE },
            },
          },
        ],
        { hasNextPage: true, endCursor: "p1" }
      ),
      productsPage([
        {
          node: {
            id: "gid://shopify/Product/5",
            title: "Second",
            variants: { edges: [variantEdge("51", "B", "Default Title", "20")], pageInfo: NO_MORE },
          },
        },
      ]),
    ]);
    const products = await fetchProducts(client, null);
    expect(products.map((p) => p.id)).toEqual(["gid://shopify/Product/4", "gid://shopify/Product/5"]);
  });
});
