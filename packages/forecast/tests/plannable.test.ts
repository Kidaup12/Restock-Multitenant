import { describe, it, expect } from "vitest";
import { plannableReason, isPlannable } from "../src/plannable";

/**
 * The buy list can only reason about products with sane unit economics. A blank
 * cost, a blank price, or a cost ABOVE the price (you never restock at a loss —
 * in practice it means bad data) must be kept off the list and surfaced for the
 * owner to fix, never silently budgeted. A single absurd-cost row force-included
 * as critical can overflow every budget tier.
 */
describe("plannableReason", () => {
  it("accepts a normal product (cost below price)", () => {
    expect(plannableReason({ costKes: 1200, priceKes: 2700 })).toBe("ok");
    expect(isPlannable({ costKes: 1200, priceKes: 2700 })).toBe(true);
  });

  it("accepts break-even (cost equals price)", () => {
    expect(plannableReason({ costKes: 2000, priceKes: 2000 })).toBe("ok");
  });

  it("rejects a missing cost (costKes <= 0)", () => {
    expect(plannableReason({ costKes: 0, priceKes: 2000 })).toBe("missing-cost");
    expect(isPlannable({ costKes: 0, priceKes: 2000 })).toBe(false);
  });

  it("rejects a missing price (priceKes <= 0)", () => {
    expect(plannableReason({ costKes: 1200, priceKes: 0 })).toBe("missing-price");
  });

  it("rejects cost-exceeds-price", () => {
    expect(plannableReason({ costKes: 1_626_053, priceKes: 2000 })).toBe("cost-exceeds-price");
    expect(isPlannable({ costKes: 1_626_053, priceKes: 2000 })).toBe(false);
  });

  it("checks missing cost before cost-exceeds-price (a 0 cost is 'missing', not 'exceeds')", () => {
    expect(plannableReason({ costKes: 0, priceKes: 0 })).toBe("missing-cost");
  });
});
