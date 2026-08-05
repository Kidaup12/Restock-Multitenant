import { describe, expect, it } from "vitest";
import { planPosIngest } from "../src/aggregate";
import type { PosSaleInput } from "../src/types";

/**
 * Pure ingest-planner rules — the semantics every downstream write depends on.
 * A fixed UTC day key keeps these tests independent of the tenant-timezone
 * helper (exercised separately in time.test.ts).
 */

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

const skuMap = new Map([
  ["can-she-340", "prod-cantu"],
  ["nl-gly-750", "prod-glycerine"],
]);
const prices = new Map([
  ["prod-cantu", 1650],
  ["prod-glycerine", 450],
]);

function sale(over: Partial<PosSaleInput> & { lines: PosSaleInput["lines"] }): PosSaleInput {
  return {
    externalId: "S1",
    date: new Date("2026-07-15T09:00:00Z"),
    warehouse: "Kilimani",
    ...over,
  };
}

describe("planPosIngest — matching", () => {
  it("matches by exact normalized SKU and aggregates per product/day", () => {
    const plan = planPosIngest({
      sales: [
        sale({ externalId: "S1", lines: [{ sku: "CAN-SHE-340", qty: 2, subtotal: 3300 }] }),
        sale({ externalId: "S2", lines: [{ sku: " can-she-340 ", qty: 1, subtotal: 1650 }] }),
      ],
      skuToProductId: skuMap,
      priceByProductId: prices,
      dayKeyOf: utcDay,
    });
    expect(plan.linesMatched).toBe(2);
    expect(plan.salesHistory).toHaveLength(1);
    expect(plan.salesHistory[0]).toMatchObject({
      productId: "prod-cantu",
      dayKey: "2026-07-15",
      quantity: 3,
      revenueKes: 4950,
    });
  });

  it("keeps unmatched till lines (never drops), stores them with productId null, and counts them", () => {
    const plan = planPosIngest({
      sales: [
        sale({
          lines: [
            { sku: "MYSTERY-BAG", qty: 4, subtotal: 200 },
            { sku: "CAN-SHE-340", qty: 1, subtotal: 1650 },
          ],
        }),
      ],
      skuToProductId: skuMap,
      priceByProductId: prices,
      dayKeyOf: utcDay,
    });
    expect(plan.linesUnmatched).toBe(1);
    expect(plan.linesMatched).toBe(1);
    // Both lines are stored on the raw sale; the unmatched one carries null.
    const stored = plan.sales[0]!.lines;
    expect(stored).toHaveLength(2);
    expect(stored.find((l) => l.sku === "MYSTERY-BAG")!.productId).toBeNull();
    // Unmatched roll-up carries units + revenue for the fix queue.
    expect(plan.unmatched).toEqual([
      { sku: "MYSTERY-BAG", productName: "", units: 4, revenueKes: 200 },
    ]);
    // Unmatched revenue never landed in SalesHistory (only the matched line did).
    expect(plan.salesHistory).toHaveLength(1);
    expect(plan.salesHistory[0]!.productId).toBe("prod-cantu");
  });
});

describe("planPosIngest — revenue fallback", () => {
  it("prefers till subtotal, then price×qty, then catalogue price", () => {
    const plan = planPosIngest({
      sales: [
        sale({ externalId: "A", date: new Date("2026-07-01T09:00:00Z"), lines: [{ sku: "CAN-SHE-340", qty: 2, subtotal: 3000 }] }),
        sale({ externalId: "B", date: new Date("2026-07-02T09:00:00Z"), lines: [{ sku: "CAN-SHE-340", qty: 2, price: 1600 }] }),
        sale({ externalId: "C", date: new Date("2026-07-03T09:00:00Z"), lines: [{ sku: "CAN-SHE-340", qty: 2 }] }),
      ],
      skuToProductId: skuMap,
      priceByProductId: prices,
      dayKeyOf: utcDay,
    });
    const byDay = Object.fromEntries(plan.salesHistory.map((r) => [r.dayKey, r.revenueKes]));
    expect(byDay["2026-07-01"]).toBe(3000); // subtotal wins
    expect(byDay["2026-07-02"]).toBe(3200); // price×qty
    expect(byDay["2026-07-03"]).toBe(3300); // catalogue price×qty (1650×2)
  });

  it("falls to zero revenue for a matched line with no price signal and no catalogue price", () => {
    const plan = planPosIngest({
      sales: [sale({ lines: [{ sku: "CAN-SHE-340", qty: 2 }] })],
      skuToProductId: skuMap,
      priceByProductId: new Map(),
      dayKeyOf: utcDay,
    });
    expect(plan.salesHistory[0]!.revenueKes).toBe(0);
    expect(plan.salesHistory[0]!.quantity).toBe(2);
  });
});

describe("planPosIngest — double-count exclusion", () => {
  it("excludes online receipts (by channel or SHOPIFY operator) so POS never doubles Shopify", () => {
    const plan = planPosIngest({
      sales: [
        sale({ externalId: "web-1", channel: "shopify", lines: [{ sku: "CAN-SHE-340", qty: 5, subtotal: 8250 }] }),
        sale({ externalId: "web-2", createdBy: "SHOPIFY", lines: [{ sku: "CAN-SHE-340", qty: 3, subtotal: 4950 }] }),
        sale({ externalId: "till-1", createdBy: "Grace", lines: [{ sku: "CAN-SHE-340", qty: 1, subtotal: 1650 }] }),
      ],
      skuToProductId: skuMap,
      priceByProductId: prices,
      dayKeyOf: utcDay,
    });
    expect(plan.salesExcluded).toBe(2);
    expect(plan.sales).toHaveLength(1);
    expect(plan.sales[0]!.externalId).toBe("till-1");
    expect(plan.salesHistory[0]!.quantity).toBe(1); // only the physical sale counted
  });
});

describe("planPosIngest — ignore rules", () => {
  it("skips an ignored till SKU from SalesHistory and the unmatched count, but still stores the raw line", () => {
    const plan = planPosIngest({
      sales: [
        sale({
          lines: [
            { sku: "CARRIER-BAG", qty: 10, subtotal: 100 },
            { sku: "CAN-SHE-340", qty: 1, subtotal: 1650 },
          ],
        }),
      ],
      skuToProductId: skuMap,
      ignoredSkus: new Set(["carrier-bag"]),
      priceByProductId: prices,
      dayKeyOf: utcDay,
    });
    expect(plan.linesIgnored).toBe(1);
    expect(plan.linesUnmatched).toBe(0); // ignored ≠ unmatched
    expect(plan.unmatched).toHaveLength(0);
    expect(plan.salesHistory).toHaveLength(1); // only the real product
    expect(plan.sales[0]!.lines).toHaveLength(2); // raw fidelity kept
  });
});

describe("planPosIngest — location attribution", () => {
  const warehouseMap = new Map([
    ["kilimani", "loc-kilimani"],
    ["westlands", "loc-westlands"],
  ]);

  it("attributes a product/day to a single mapped branch", () => {
    const plan = planPosIngest({
      sales: [sale({ warehouse: "Kilimani", lines: [{ sku: "CAN-SHE-340", qty: 2, subtotal: 3300 }] })],
      skuToProductId: skuMap,
      priceByProductId: prices,
      warehouseToLocationId: warehouseMap,
      dayKeyOf: utcDay,
    });
    expect(plan.salesHistory[0]!.locationId).toBe("loc-kilimani");
  });

  it("declines attribution when the same product sold at two branches that day", () => {
    const plan = planPosIngest({
      sales: [
        sale({ externalId: "K", warehouse: "Kilimani", lines: [{ sku: "CAN-SHE-340", qty: 2, subtotal: 3300 }] }),
        sale({ externalId: "W", warehouse: "Westlands", lines: [{ sku: "CAN-SHE-340", qty: 1, subtotal: 1650 }] }),
      ],
      skuToProductId: skuMap,
      priceByProductId: prices,
      warehouseToLocationId: warehouseMap,
      dayKeyOf: utcDay,
    });
    expect(plan.salesHistory).toHaveLength(1);
    expect(plan.salesHistory[0]!.quantity).toBe(3);
    expect(plan.salesHistory[0]!.locationId).toBeNull(); // mixed day → decline, don't guess
  });

  it("leaves locationId null for an unmapped till (surfaced separately)", () => {
    const plan = planPosIngest({
      sales: [sale({ warehouse: "Pop-up Stall", lines: [{ sku: "CAN-SHE-340", qty: 1, subtotal: 1650 }] })],
      skuToProductId: skuMap,
      priceByProductId: prices,
      warehouseToLocationId: warehouseMap,
      dayKeyOf: utcDay,
    });
    expect(plan.salesHistory[0]!.locationId).toBeNull();
  });
});

describe("planPosIngest — determinism (set-semantics foundation)", () => {
  it("produces identical output for the same input (a window replays to the same rows)", () => {
    const input = {
      sales: [
        sale({ externalId: "S1", lines: [{ sku: "CAN-SHE-340", qty: 2, subtotal: 3300 }] }),
        sale({ externalId: "S2", lines: [{ sku: "NL-GLY-750", qty: 4, subtotal: 1800 }] }),
      ],
      skuToProductId: skuMap,
      priceByProductId: prices,
      dayKeyOf: utcDay,
    };
    expect(planPosIngest(input)).toEqual(planPosIngest(input));
  });
});

describe("planPosIngest — duplicate external ids in one payload", () => {
  /**
   * A bridge resending a receipt inside one batch used to take the whole batch
   * down: the delete removed the stored row once, then createMany inserted the
   * same id twice against a unique constraint — losing every other valid sale
   * in the request. Duplicates would also have double-counted the day's units.
   */
  it("keeps one sale per external id, and counts it once", () => {
    const plan = planPosIngest({
      sales: [
        sale({ externalId: "DUP-1", lines: [{ sku: "CAN-SHE-340", qty: 2 }] }),
        sale({ externalId: "OTHER", lines: [{ sku: "NL-GLY-750", qty: 1 }] }),
        sale({ externalId: "DUP-1", lines: [{ sku: "CAN-SHE-340", qty: 5 }] }),
      ],
      skuToProductId: skuMap,
      priceByProductId: prices,
      dayKeyOf: utcDay,
    });

    expect(plan.externalIds.filter((id) => id === "DUP-1")).toHaveLength(1);
    expect(plan.sales).toHaveLength(2);

    // Last occurrence wins — the rule a resend already follows against the
    // stored rows, so a payload and a re-POST of its tail agree.
    const kept = plan.sales.find((s) => s.externalId === "DUP-1");
    expect(kept?.lines[0]?.qty).toBe(5);

    // Counted once, not 2 + 5.
    const cantu = plan.salesHistory.find((r) => r.productId === "prod-cantu");
    expect(cantu?.quantity).toBe(5);

    // The valid sale alongside it still survives the batch.
    expect(plan.sales.some((s) => s.externalId === "OTHER")).toBe(true);
  });
});
