/**
 * Pure PO sizing math: order quantities → PO lines with costs and totals.
 *
 * Quantities are carried as-is from the queued Order rows (the forecast's
 * reorder engine already sized them); the only adjustment here is the supplier
 * MOQ floor — a supplier who won't ship fewer than `moq` units of a SKU gets
 * the line raised to that minimum. The pre-floor quantity is preserved as
 * `recommendedQty` so recommended-vs-actual stays measurable.
 */

export type LineInput = {
  productId: string;
  sku: string;
  title: string;
  /** Queued order quantity (pre-MOQ). */
  qty: number;
  unitCostKes: number;
};

export type PoLinePlan = {
  productId: string;
  sku: string;
  title: string;
  quantity: number;
  unitCostKes: number;
  lineTotalKes: number;
  recommendedQty: number;
};

/** Raise a quantity to the supplier's minimum order quantity. */
export function applyMoq(qty: number, moq: number): number {
  const wanted = Math.max(1, Math.ceil(qty));
  return Math.max(wanted, Math.max(1, Math.floor(moq) || 1));
}

/** Build the line set for one supplier's PO. Duplicate products merge first
 *  (summed quantities), then the MOQ floor applies per line. */
export function buildPoLines(inputs: LineInput[], moq: number): PoLinePlan[] {
  const byProduct = new Map<string, LineInput>();
  for (const input of inputs) {
    const existing = byProduct.get(input.productId);
    if (existing) existing.qty += input.qty;
    else byProduct.set(input.productId, { ...input });
  }
  return [...byProduct.values()].map((line) => {
    const recommendedQty = Math.max(1, Math.ceil(line.qty));
    const quantity = applyMoq(line.qty, moq);
    return {
      productId: line.productId,
      sku: line.sku,
      title: line.title,
      quantity,
      unitCostKes: line.unitCostKes,
      lineTotalKes: quantity * line.unitCostKes,
      recommendedQty,
    };
  });
}

export function subtotal(lines: Pick<PoLinePlan, "lineTotalKes">[]): number {
  return lines.reduce((sum, l) => sum + l.lineTotalKes, 0);
}
