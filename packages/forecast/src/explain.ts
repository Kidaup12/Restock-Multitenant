/**
 * Human-traceable breakdown of a reorder quantity: tap any recommended
 * quantity and see the simple math. Built from reorderBreakdown() — the single
 * source of truth for BOTH the number and its parts — so the shown arithmetic
 * always sums to the quantity on the buy list, for every rule (mean cover,
 * calibrated, min/max), not just mean cover.
 *
 * Each rule reconciles the same way:
 *   targetUnits − currentStock − onOrder = recommendedQty   (floored at 0)
 * where targetUnits is the shelf level the rule stocks up to. When the caller
 * overrides the sizing (e.g. the pipeline zeroes a dead or too-new item) the
 * breakdown states the hold plainly instead of printing arithmetic that would
 * not add up.
 */
import { reorderBreakdown, type ReorderInput, type ReorderMethod } from "./reorder";

export type QtyExplanation = {
  method: ReorderMethod;
  dailyForecast: number; // finalForecast30d / 30 — the capped run rate, per day
  windowDays: number; // days of demand the target protects
  coverDays: number; // alias of windowDays (kept for existing readers)
  demandOverCover: number; // dailyForecast × windowDays (mean cover; 0 otherwise)
  safetyStock: number;
  currentStock: number;
  onOrder: number; // incoming / en-route
  targetUnits: number; // shelf level the rule stocks up to
  recommendedQty: number;
  summary: string;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** How the target was set, in the buy list's plain voice. */
function qualifier(b: ReturnType<typeof reorderBreakdown>): string {
  switch (b.method) {
    case "calibrated":
      return `covers ${b.windowDays}d of demand at ${Math.round((b.serviceLevel ?? 0) * 100)}% service`;
    case "min_max":
      return `2-week par + ${r1(b.safetyStock)} buffer`;
    default:
      return `${r1(b.dailyForecast)}/day × ${b.windowDays}d + ${r1(b.safetyStock)} buffer`;
  }
}

/**
 * @param finalQty the caller's already-decided quantity. Pass it whenever the
 * caller may override the raw sizing rule (e.g. the pipeline zeroes a dead or
 * too-new item that min/max would otherwise floor at 1) so the breakdown never
 * drifts from the persisted number. Omitted -> use the rule's quantity.
 */
export function explainQty(input: ReorderInput, finalQty?: number): QtyExplanation {
  const b = reorderBreakdown(input);
  const qty = finalQty ?? b.qty;

  let summary: string;
  if (finalQty != null && finalQty !== b.qty) {
    // The caller overrode the rule — don't print arithmetic that won't add up.
    summary = `held off the buy list = ${qty}`;
  } else if (qty === 0) {
    summary =
      `already covered — ${b.targetUnits} target ≤ ${r1(b.currentStock)} on hand` +
      ` + ${r1(b.onOrder)} incoming = 0`;
  } else {
    summary =
      `stock up to ${b.targetUnits} (${qualifier(b)})` +
      ` − ${r1(b.currentStock)} on hand − ${r1(b.onOrder)} incoming = ${qty}`;
  }

  return {
    method: b.method,
    dailyForecast: b.dailyForecast,
    windowDays: b.windowDays,
    coverDays: b.windowDays,
    demandOverCover: b.demandOverCover,
    safetyStock: b.safetyStock,
    currentStock: b.currentStock,
    onOrder: b.onOrder,
    targetUnits: b.targetUnits,
    recommendedQty: qty,
    summary,
  };
}
