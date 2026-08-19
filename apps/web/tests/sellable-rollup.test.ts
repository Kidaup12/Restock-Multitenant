import { describe, expect, it } from "vitest";
import { recomputeSellableStock } from "../lib/inventory/sellable-rollup";

/**
 * The sellable rollup, exercised through a stub client.
 *
 * `Product.currentStock` is stored, not derived, so every rule here is a way the
 * stored number can drift from the truth it is supposed to summarise — which is
 * exactly what happened in production, where a corrected location role left the
 * rollup reading a figure from before the correction.
 */

type Level = {
  productId: string;
  available: number | null;
  onHand: number;
  location: { locationType: string | null } | null;
};

function stub(levels: Level[]) {
  const written: Record<string, number> = {};
  return {
    written,
    client: {
      inventoryLevel: {
        async findMany({ where }: { where: { productId: { in: string[] } } }) {
          return levels.filter((l) => where.productId.in.includes(l.productId));
        },
      },
      product: {
        async update({ where, data }: { where: { id: string }; data: { currentStock: number } }) {
          written[where.id] = data.currentStock;
          return null;
        },
      },
    },
  };
}

const at = (type: string | null, units: number, productId = "p1"): Level => ({
  productId,
  available: units,
  onHand: units,
  location: { locationType: type },
});

describe("recomputeSellableStock", () => {
  it("counts branches and ignores warehouses", async () => {
    const s = stub([at("branch", 10), at("warehouse", 90)]);
    await recomputeSellableStock(s.client, ["p1"]);
    expect(s.written.p1).toBe(10);
  });

  it("treats an unclassified location as sellable, matching the shared rule", async () => {
    const s = stub([at(null, 7)]);
    await recomputeSellableStock(s.client, ["p1"]);
    expect(s.written.p1).toBe(7);
  });

  it("excludes en-route and virtual stock", async () => {
    const s = stub([at("branch", 5), at("enroute", 50), at("virtual", 50)]);
    await recomputeSellableStock(s.client, ["p1"]);
    expect(s.written.p1).toBe(5);
  });

  it("writes a product down to zero when its last sellable location stops selling", async () => {
    // THE regression. A shopfront re-confirmed as a warehouse leaves the product
    // with no sellable level at all; keeping the previous figure is the same
    // silent corruption the role prompt exists to prevent, pointing the other
    // way.
    const s = stub([at("warehouse", 120)]);
    await recomputeSellableStock(s.client, ["p1"]);
    expect(s.written.p1).toBe(0);
  });

  it("writes a product with no levels at all down to zero", async () => {
    const s = stub([]);
    await recomputeSellableStock(s.client, ["p1"]);
    expect(s.written.p1).toBe(0);
  });

  it("prefers available over onHand, so committed units stay unsellable", async () => {
    const s = stub([{ productId: "p1", available: 3, onHand: 11, location: { locationType: "branch" } }]);
    await recomputeSellableStock(s.client, ["p1"]);
    expect(s.written.p1).toBe(3);
  });

  it("falls back to onHand when available was never written", async () => {
    const s = stub([{ productId: "p1", available: null, onHand: 11, location: { locationType: "branch" } }]);
    await recomputeSellableStock(s.client, ["p1"]);
    // Overstated, and deliberately so: reading null as 0 would empty the stock
    // screen and flood the buy list with orders for stock on the shelf.
    expect(s.written.p1).toBe(11);
  });

  it("sums several sellable locations, per product", async () => {
    const s = stub([at("branch", 4, "p1"), at("branch", 6, "p1"), at("branch", 2, "p2")]);
    await recomputeSellableStock(s.client, ["p1", "p2"]);
    expect(s.written).toEqual({ p1: 10, p2: 2 });
  });

  it("does nothing when asked for no products", async () => {
    const s = stub([at("branch", 5)]);
    await recomputeSellableStock(s.client, []);
    expect(s.written).toEqual({});
  });
});
