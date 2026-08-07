import { describe, expect, it } from "vitest";
import { applyMoq, buildPoLines, subtotal } from "../lib/po/po-math";

/**
 * Closes #18: the money shown before ordering must be the money ordered.
 *
 * A supplier's minimum order quantity was applied when the purchase order was
 * written and nowhere else. So the button offered "90 units · KES 84,000" and
 * created 108 units · KES 96,600, and across one forecast run the gap was
 * KES 161,500 on a KES 1.08M plan — a 15% understatement. An owner who says
 * they have KES 500,000 to spend was handed a plan that quietly cost more.
 *
 * The fix is that the preview runs the SAME `buildPoLines` the write path runs,
 * and the plan prices its floored quantity. These tests hold that equality,
 * because the failure mode is silent: both numbers look perfectly reasonable on
 * their own, and only differ when compared.
 */

const line = (productId: string, qty: number, unitCostKes: number) => ({
  productId,
  sku: `SKU-${productId}`,
  title: `Product ${productId}`,
  qty,
  unitCostKes,
});

describe("the money shown is the money ordered", () => {
  it("reproduces the reported case: 90 units promised, 108 ordered", () => {
    // Six lines of 15 against a supplier who ships no fewer than 18.
    const inputs = Array.from({ length: 6 }, (_, i) => line(`p${i}`, 15, 895));
    const naive = inputs.reduce((s, l) => s + l.qty, 0);
    expect(naive).toBe(90);

    const planned = buildPoLines(inputs, 18);
    expect(planned.reduce((s, l) => s + l.quantity, 0)).toBe(108);
    // Which is what the PO bills — the preview must say this number.
    expect(subtotal(planned)).toBe(108 * 895);
    expect(subtotal(planned)).toBeGreaterThan(naive * 895);
  });

  it("never shows less than the order will cost, at any MOQ", () => {
    for (const moq of [1, 2, 5, 12, 18, 24, 48]) {
      for (const qty of [1, 3, 11, 17, 40, 96]) {
        const planned = buildPoLines([line("p1", qty, 500)], moq);
        expect(subtotal(planned)).toBeGreaterThanOrEqual(qty * 500);
        expect(planned[0]!.quantity).toBe(applyMoq(qty, moq));
      }
    }
  });

  it("merges duplicate products before flooring, as the write path does", () => {
    // Two queued orders for one product: 20 + 20 against MOQ 24 is one line of
    // 40, not two lines floored to 24 each. Previewing them separately would
    // over-state by 8 units — wrong in the other direction, and still wrong.
    const planned = buildPoLines([line("p1", 20, 100), line("p1", 20, 100)], 24);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.quantity).toBe(40);
    expect(subtotal(planned)).toBe(4000);
  });

  it("keeps the pre-floor quantity, so recommended-vs-actual stays measurable", () => {
    // The floor is what we buy; the engine's number is what we thought we
    // needed. Losing the second makes the supplier's minimum invisible.
    const planned = buildPoLines([line("p1", 30, 100)], 48);
    expect(planned[0]!.quantity).toBe(48);
    expect(planned[0]!.recommendedQty).toBe(30);
  });

  it("leaves a line alone when it already clears the minimum", () => {
    const planned = buildPoLines([line("p1", 60, 100)], 48);
    expect(planned[0]!.quantity).toBe(60);
    expect(subtotal(planned)).toBe(6000);
  });

  it("treats a missing or nonsense MOQ as no floor rather than a multiplier", () => {
    for (const moq of [0, 1, -5, Number.NaN]) {
      expect(applyMoq(7, moq)).toBe(7);
    }
  });
});
