import { describe, expect, it } from "vitest";
import { bucketSalesByProductDay, computeWindowStart } from "../src/sales";
import type { ShopifyOrderNode } from "../src/resources";

// Keyed by NUMERIC CORE — line items below carry full gids, which
// bucketSalesByProductDay normalizes via numericCore().
const coreMap = new Map<string, string>([
  ["1", "local-1"],
  ["2", "local-2"],
]);

const orders: ShopifyOrderNode[] = [
  {
    id: "o1",
    createdAt: "2026-06-04T10:00:00Z",
    lineItems: [
      { quantity: 2, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "100" } } },
      { quantity: 1, product: { id: "gid://shopify/Product/2" }, originalUnitPriceSet: { shopMoney: { amount: "50" } } },
    ],
  },
  {
    id: "o2",
    createdAt: "2026-06-04T18:00:00Z",
    lineItems: [
      { quantity: 3, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "100" } } },
    ],
  },
  {
    id: "o3",
    createdAt: "2026-06-04T12:00:00Z",
    lineItems: [
      { quantity: 5, product: { id: "gid://shopify/Product/99" }, originalUnitPriceSet: { shopMoney: { amount: "10" } } }, // unknown product — skipped
    ],
  },
];

describe("bucketSalesByProductDay", () => {
  it("sums quantity + revenue per (product, day)", () => {
    const buckets = bucketSalesByProductDay(orders, coreMap);
    expect(buckets.get("local-1|2026-06-04")).toEqual({
      productId: "local-1", dateKey: "2026-06-04", quantity: 5, revenue: 500, locationId: null,
    });
  });

  it("keeps separate products on the same day separate", () => {
    const buckets = bucketSalesByProductDay(orders, coreMap);
    expect(buckets.get("local-2|2026-06-04")).toEqual({
      productId: "local-2", dateKey: "2026-06-04", quantity: 1, revenue: 50, locationId: null,
    });
  });

  it("skips line items whose product is not in the catalog", () => {
    const buckets = bucketSalesByProductDay(orders, coreMap);
    expect([...buckets.keys()].some((k) => k.includes("99"))).toBe(false);
  });

  it("is pure — running twice yields identical buckets (idempotent input)", () => {
    const a = bucketSalesByProductDay(orders, coreMap);
    const b = bucketSalesByProductDay(orders, coreMap);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("buckets by processedAt (sale date), falling back to createdAt", () => {
    const backdated: ShopifyOrderNode[] = [
      {
        // Imported/back-dated order: sold 2026-05-10, hit the API 2026-06-04.
        id: "o4",
        createdAt: "2026-06-04T10:00:00Z",
        processedAt: "2026-05-10T09:00:00Z",
        lineItems: [
          { quantity: 1, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "100" } } },
        ],
      },
      {
        // No processedAt — createdAt is the only date available.
        id: "o5",
        createdAt: "2026-06-04T11:00:00Z",
        lineItems: [
          { quantity: 2, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "100" } } },
        ],
      },
    ];
    const buckets = bucketSalesByProductDay(backdated, coreMap);
    expect(buckets.get("local-1|2026-05-10")).toEqual({
      productId: "local-1", dateKey: "2026-05-10", quantity: 1, revenue: 100, locationId: null,
    });
    expect(buckets.get("local-1|2026-06-04")).toEqual({
      productId: "local-1", dateKey: "2026-06-04", quantity: 2, revenue: 200, locationId: null,
    });
  });

  it("matches bare-id line items against the same core (no gid twins)", () => {
    const bare: ShopifyOrderNode[] = [
      {
        id: "o6",
        createdAt: "2026-06-05T08:00:00Z",
        lineItems: [{ quantity: 1, product: { id: "1" }, originalUnitPriceSet: { shopMoney: { amount: "10" } } }],
      },
    ];
    expect(bucketSalesByProductDay(bare, coreMap).get("local-1|2026-06-05")?.quantity).toBe(1);
  });
});

describe("computeWindowStart", () => {
  const now = new Date("2026-07-20T15:30:00Z");

  it("first run: looks back the configured days, floored to UTC midnight", () => {
    const start = computeWindowStart(null, now, { overlapHours: 6, firstRunLookbackDays: 365 });
    expect(start.toISOString()).toBe("2025-07-20T00:00:00.000Z");
  });

  it("subsequent runs: cursor minus overlap, floored to UTC midnight", () => {
    const cursor = new Date("2026-07-19T03:00:00Z");
    const start = computeWindowStart(cursor, now, { overlapHours: 6, firstRunLookbackDays: 365 });
    // 03:00 - 6h crosses midnight → floors to the 18th.
    expect(start.toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });
});
