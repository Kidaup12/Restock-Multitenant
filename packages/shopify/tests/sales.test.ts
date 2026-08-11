import { describe, expect, it } from "vitest";
import { bucketSalesByProductDay, computeWindowStart } from "../src/sales";
import type { ShopifyOrderNode } from "../src/resources";

/** The day key these fixtures were written against. Real callers pass the
 *  tenant's zone; the cases below only care that a day is a day. */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The tenant rule, as the worker applies it — same helper the till feed uses. */
const nairobiDay = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

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

/**
 * Per-branch attribution — the gap item 8 exists to close.
 *
 * A day that traded at two branches currently collapses to ONE row with no
 * location, because SalesHistory allows one row per (product, day, channel) and
 * the bucketer declines to guess which branch it belonged to. So the busiest
 * days — the ones where every branch sold — are exactly the days that carry no
 * location, and a per-branch run rate cannot be computed from them.
 *
 * The assertion that matters when this changes is the LAST one: however the rows
 * are split, the units must still sum to what the shop actually sold. Widening
 * the unique key without that check is how a migration turns one sale into two
 * and has the buy list order double.
 */
describe("per-branch attribution (item 8 — current behaviour, pinned)", () => {
  const twoBranchDay: ShopifyOrderNode[] = [
    {
      id: "kilimani",
      createdAt: "2026-06-04T09:00:00Z",
      fulfillments: [{ location: { id: "gid://shopify/Location/10" } }],
      lineItems: [
        { quantity: 4, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "100" } } },
      ],
    },
    {
      id: "westlands",
      createdAt: "2026-06-04T15:00:00Z",
      fulfillments: [{ location: { id: "gid://shopify/Location/20" } }],
      lineItems: [
        { quantity: 6, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "100" } } },
      ],
    },
  ];
  const locMap = new Map<string, string>([["10", "loc-kilimani"], ["20", "loc-westlands"]]);

  it("attributes a single-branch day to that branch", () => {
    const oneBranch = [twoBranchDay[0]!];
    const buckets = bucketSalesByProductDay(oneBranch, coreMap, utcDay, locMap);
    expect([...buckets.values()]).toHaveLength(1);
    expect([...buckets.values()][0]).toMatchObject({ quantity: 4, locationId: "loc-kilimani" });
  });

  it("keeps both branches on a day that traded at two", () => {
    const buckets = bucketSalesByProductDay(twoBranchDay, coreMap, utcDay, locMap);
    const rows = [...buckets.values()];
    // Was one unattributed row until 2026-08-11: the day the shop was busiest
    // was the day it could not say where the demand came from.
    expect(rows).toHaveLength(2);
    const byLocation = new Map(rows.map((r) => [r.locationId, r.quantity]));
    expect(byLocation.get("loc-kilimani")).toBe(4);
    expect(byLocation.get("loc-westlands")).toBe(6);
  });

  it("still declines to guess when an order carries no branch", () => {
    const noLocation = [{ ...twoBranchDay[0]!, fulfillments: [] }];
    const rows = [...bucketSalesByProductDay(noLocation, coreMap, utcDay, locMap).values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locationId).toBeNull();
  });

  it("never changes the total units, however the day is split", () => {
    // The guard for the migration. Widening the key must redistribute these
    // units, never mint new ones: a double count here inflates the run rate,
    // and the run rate is what sizes every order on the buy list.
    const rows = [...bucketSalesByProductDay(twoBranchDay, coreMap, utcDay, locMap).values()];
    const units = rows.reduce((sum, r) => sum + r.quantity, 0);
    const revenue = rows.reduce((sum, r) => sum + r.revenue, 0);
    expect(units).toBe(10);
    expect(revenue).toBe(1000);
  });
});
describe("bucketSalesByProductDay", () => {
  it("sums quantity + revenue per (product, day)", () => {
    const buckets = bucketSalesByProductDay(orders, coreMap, utcDay);
    expect(buckets.get("local-1|2026-06-04|")).toEqual({
      productId: "local-1", dateKey: "2026-06-04", quantity: 5, revenue: 500, locationId: null,
    });
  });

  it("keeps separate products on the same day separate", () => {
    const buckets = bucketSalesByProductDay(orders, coreMap, utcDay);
    expect(buckets.get("local-2|2026-06-04|")).toEqual({
      productId: "local-2", dateKey: "2026-06-04", quantity: 1, revenue: 50, locationId: null,
    });
  });

  it("files a late-night sale on the shop's day, not the UTC one", () => {
    // 01:30 on the 5th in Nairobi is still 22:30 on the 4th in UTC. Reading the
    // timestamp as UTC would book this sale a day early and split one day of
    // trade across two rows — the till feed keys the same sale to the 5th.
    const lateNight: ShopifyOrderNode[] = [
      {
        id: "gid://shopify/Order/9001",
        processedAt: "2026-06-04T22:30:00Z",
        lineItems: [
          {
            quantity: 2,
            product: { id: "gid://shopify/Product/1" },
            originalUnitPriceSet: { shopMoney: { amount: "100" } },
          },
        ],
      } as ShopifyOrderNode,
    ];

    expect(bucketSalesByProductDay(lateNight, coreMap, nairobiDay).get("local-1|2026-06-05|")).toMatchObject({
      dateKey: "2026-06-05",
      quantity: 2,
    });
    // The old behaviour, kept visible so the difference is the point.
    expect(bucketSalesByProductDay(lateNight, coreMap, utcDay).get("local-1|2026-06-04|")).toMatchObject({
      dateKey: "2026-06-04",
    });
  });

  it("nets returned units off the day they were sold", () => {
    // Two sold, one handed back. The shop moved one, so the run rate must see
    // one — otherwise the forecast replaces stock that walked back in.
    const withRefund: ShopifyOrderNode[] = [
      {
        id: "gid://shopify/Order/9100",
        processedAt: "2026-06-10T09:00:00Z",
        refunds: [
          { refundLineItems: [{ quantity: 1, lineItem: { id: "gid://shopify/LineItem/1" } }] },
        ],
        lineItems: [
          {
            id: "gid://shopify/LineItem/1",
            quantity: 2,
            product: { id: "gid://shopify/Product/1" },
            originalUnitPriceSet: { shopMoney: { amount: "100" } },
          },
        ],
      } as ShopifyOrderNode,
    ];
    expect(bucketSalesByProductDay(withRefund, coreMap, utcDay).get("local-1|2026-06-10|")).toMatchObject({
      quantity: 1,
      revenue: 100,
    });
  });

  it("drops a line returned in full rather than recording a zero sale", () => {
    const fullyReturned: ShopifyOrderNode[] = [
      {
        id: "gid://shopify/Order/9101",
        processedAt: "2026-06-11T09:00:00Z",
        refunds: [
          { refundLineItems: [{ quantity: 3, lineItem: { id: "gid://shopify/LineItem/2" } }] },
        ],
        lineItems: [
          {
            id: "gid://shopify/LineItem/2",
            quantity: 3,
            product: { id: "gid://shopify/Product/1" },
            originalUnitPriceSet: { shopMoney: { amount: "100" } },
          },
        ],
      } as ShopifyOrderNode,
    ];
    expect(bucketSalesByProductDay(fullyReturned, coreMap, utcDay).size).toBe(0);
  });

  it("ignores a cancelled order entirely — it never became a sale", () => {
    const cancelled: ShopifyOrderNode[] = [
      {
        id: "gid://shopify/Order/9102",
        processedAt: "2026-06-12T09:00:00Z",
        cancelledAt: "2026-06-12T10:00:00Z",
        lineItems: [
          {
            id: "gid://shopify/LineItem/3",
            quantity: 5,
            product: { id: "gid://shopify/Product/1" },
            originalUnitPriceSet: { shopMoney: { amount: "100" } },
          },
        ],
      } as ShopifyOrderNode,
    ];
    expect(bucketSalesByProductDay(cancelled, coreMap, utcDay).size).toBe(0);
  });

  it("nets partial returns across several refunds on one line", () => {
    const twice: ShopifyOrderNode[] = [
      {
        id: "gid://shopify/Order/9103",
        processedAt: "2026-06-13T09:00:00Z",
        refunds: [
          { refundLineItems: [{ quantity: 1, lineItem: { id: "gid://shopify/LineItem/4" } }] },
          { refundLineItems: [{ quantity: 2, lineItem: { id: "gid://shopify/LineItem/4" } }] },
        ],
        lineItems: [
          {
            id: "gid://shopify/LineItem/4",
            quantity: 10,
            product: { id: "gid://shopify/Product/1" },
            originalUnitPriceSet: { shopMoney: { amount: "50" } },
          },
        ],
      } as ShopifyOrderNode,
    ];
    expect(bucketSalesByProductDay(twice, coreMap, utcDay).get("local-1|2026-06-13|")).toMatchObject({
      quantity: 7,
      revenue: 350,
    });
  });

  it("skips a sale whose timestamp cannot be read as an instant", () => {
    const broken: ShopifyOrderNode[] = [
      {
        id: "gid://shopify/Order/9002",
        processedAt: "not-a-date",
        lineItems: [
          {
            quantity: 1,
            product: { id: "gid://shopify/Product/1" },
            originalUnitPriceSet: { shopMoney: { amount: "100" } },
          },
        ],
      } as ShopifyOrderNode,
    ];
    expect(bucketSalesByProductDay(broken, coreMap, nairobiDay).size).toBe(0);
  });

  it("skips line items whose product is not in the catalog", () => {
    const buckets = bucketSalesByProductDay(orders, coreMap, utcDay);
    expect([...buckets.keys()].some((k) => k.includes("99"))).toBe(false);
  });

  it("is pure — running twice yields identical buckets (idempotent input)", () => {
    const a = bucketSalesByProductDay(orders, coreMap, utcDay);
    const b = bucketSalesByProductDay(orders, coreMap, utcDay);
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
    const buckets = bucketSalesByProductDay(backdated, coreMap, utcDay);
    expect(buckets.get("local-1|2026-05-10|")).toEqual({
      productId: "local-1", dateKey: "2026-05-10", quantity: 1, revenue: 100, locationId: null,
    });
    expect(buckets.get("local-1|2026-06-04|")).toEqual({
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
    expect(bucketSalesByProductDay(bare, coreMap, utcDay).get("local-1|2026-06-05|")?.quantity).toBe(1);
  });

  it("attributes a sale to the VARIANT's row, not an arbitrary sibling", () => {
    // Two shades of one product: the product map can only point at one of them,
    // so a product-keyed lookup would file both shades' sales on the same row.
    const variantMap = new Map<string, string>([
      ["11", "local-shade-a"],
      ["12", "local-shade-b"],
    ]);
    const sameProduct: ShopifyOrderNode[] = [
      {
        id: "o7",
        createdAt: "2026-06-06T08:00:00Z",
        lineItems: [
          {
            quantity: 2,
            product: { id: "gid://shopify/Product/1" },
            variant: { id: "gid://shopify/ProductVariant/12" },
            originalUnitPriceSet: { shopMoney: { amount: "100" } },
          },
        ],
      },
    ];
    const buckets = bucketSalesByProductDay(sameProduct, coreMap, utcDay, undefined, variantMap);
    expect(buckets.get("local-shade-b|2026-06-06|")?.quantity).toBe(2);
    expect(buckets.has("local-1|2026-06-06|")).toBe(false);
  });

  it("falls back to the product map for a line with no variant", () => {
    const noVariant: ShopifyOrderNode[] = [
      {
        id: "o8",
        createdAt: "2026-06-07T08:00:00Z",
        lineItems: [
          { quantity: 1, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "100" } } },
        ],
      },
    ];
    const buckets = bucketSalesByProductDay(noVariant, coreMap, utcDay, undefined, new Map());
    expect(buckets.get("local-1|2026-06-07|")?.quantity).toBe(1);
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
