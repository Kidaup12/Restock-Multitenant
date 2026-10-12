import { applyMoq, isPlannable } from "@wezesha/forecast";

/** Mirror the default planner decision; an override cannot bypass open orders or bad costs. */
export function reportOrderQuantity(input: {
  recommendedQty: number;
  overrideQty?: number;
  moq?: number;
  finalForecast30d: number;
  urgency: string;
  costKes: number;
  priceKes: number;
  hasOpenOrder: boolean;
}): number {
  if (input.hasOpenOrder || !isPlannable(input)) return 0;
  const qty = input.overrideQty ?? Math.round(input.recommendedQty);
  if (qty <= 0) return 0;
  if (input.overrideQty == null && input.urgency === "low" && input.finalForecast30d / 30 < 1) return 0;
  return applyMoq(qty, input.moq ?? 1);
}
