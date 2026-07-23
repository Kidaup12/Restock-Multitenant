/**
 * Can a product go on the restock buy list? The budget planner can only reason
 * about items with sane unit economics: a positive cost AND a price that at
 * least covers it. Items that fail are NOT silently dropped — the planner
 * surfaces them ("check this cost") so the owner can fix the data.
 *
 * Why exclude cost > price: you never restock at a loss, and a cost far above
 * price means bad data. A single such row, force-included as critical, can
 * overflow every budget tier so that changing the budget changes nothing.
 */
export type CostShape = { costKes: number; priceKes: number };

export type PlannableReason = "ok" | "missing-cost" | "missing-price" | "cost-exceeds-price";

/** Diagnose why a product can or can't be budgeted. Order matters: a blank cost
 *  is reported as "missing-cost" (actionable) before the "exceeds" check. */
export function plannableReason(p: CostShape): PlannableReason {
  if (!(p.costKes > 0)) return "missing-cost";
  if (!(p.priceKes > 0)) return "missing-price";
  if (p.costKes > p.priceKes) return "cost-exceeds-price";
  return "ok";
}

export function isPlannable(p: CostShape): boolean {
  return plannableReason(p) === "ok";
}
