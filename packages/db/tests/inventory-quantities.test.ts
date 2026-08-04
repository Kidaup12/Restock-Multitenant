import { describe, expect, it } from "vitest";
import { committedUnits, sellableUnits } from "../src/inventory";

/**
 * Which stored quantity answers "how much can we actually sell".
 *
 * The system counted on_hand, which includes units already promised to
 * customers, so days-of-cover read high and the buy list ordered short by
 * exactly the committed amount. The fallback is the load-bearing part: a row no
 * available-aware sync has written must degrade to the OLD overstated number,
 * never to zero — zeroing would empty the stock screen and flood the buy list
 * with orders for products sitting on the shelf.
 */

describe("sellableUnits", () => {
  it("prefers available over on-hand", () => {
    expect(sellableUnits({ available: 4, onHand: 6 })).toBe(4);
  });

  it("falls back to on-hand when available was never written", () => {
    expect(sellableUnits({ available: null, onHand: 6 })).toBe(6);
  });

  it("treats a genuine zero as zero, not as missing", () => {
    // The whole reason the column is nullable: 0 and "unknown" are different
    // answers, and a NOT NULL DEFAULT 0 could not tell them apart.
    expect(sellableUnits({ available: 0, onHand: 6 })).toBe(0);
  });
});

describe("committedUnits", () => {
  it("is the gap between what is there and what can be sold", () => {
    expect(committedUnits({ available: 4, onHand: 6 })).toBe(2);
  });

  it("is zero when nothing is known to be committed", () => {
    expect(committedUnits({ available: null, onHand: 6 })).toBe(0);
    expect(committedUnits({ available: 6, onHand: 6 })).toBe(0);
  });

  it("never reports a negative commitment", () => {
    // Shopify can report available above on_hand mid-reconcile on an oversold
    // location; "minus two units committed" is not a thing.
    expect(committedUnits({ available: 8, onHand: 6 })).toBe(0);
  });
});
