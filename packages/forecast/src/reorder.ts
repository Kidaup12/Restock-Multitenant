/**
 * Reorder math — single source of truth for order sizing.
 *
 * Mean-cover rule: ceil(demand-over-cover-window + safetyStock - currentStock
 * - onOrder), floored at 0. Subtracting `onOrder` prevents re-recommending
 * SKUs that already have stock in transit.
 *
 * A per-class OrderPolicy (the merchant's method choice, resolved by
 * config.ts) can replace the rule:
 *   - "calibrated": order up to a calibrated count-distribution quantile of
 *     demand over lead + review — validated to beat mean-cover + normal safety
 *     stock on fill rate for a modest on-hand increase.
 *   - "min_max": conservative par top-up (2 weeks + safety stock) for the slow
 *     erratic tail.
 * Without a policy, C items default to min/max and the rest to mean-cover.
 */
import { calibratedCover } from "./calibrated-quantile";
import { ORDER_REVIEW_DAYS } from "./lead-time";
import type { OrderPolicy } from "./config";

export type ReorderInput = {
  finalForecast30d: number;
  safetyStock: number;
  currentStock: number;
  onOrder: number;
  /** Days of demand this order should cover (lead + review); defaults to 30. */
  coverDays?: number;
  /** ABC class — without a policy, C items use the min/max par rule. */
  abcCategory?: string | null;
  /** Std dev of recent daily demand — required for the calibrated rule; when
   *  absent the calibrated rule falls back to mean-cover. */
  dailyDemandStd?: number;
  /** Average lead time (days). The calibrated cover protects demand over
   *  (leadTimeAvg + review) — enough to last until the restock arrives, which
   *  is what makes long-lead imports correct. Absent/unknown -> treated as 0
   *  (protect the review cycle only): no data, no inflation-by-guess. */
  leadTimeAvg?: number;
  /** Target cycle service level for the calibrated rule; overrides the
   *  per-class default when the policy doesn't carry one. */
  serviceLevel?: number;
  /** Resolved per-class ordering policy (the merchant's method choice). When
   *  present it drives the rule + service level directly. */
  policy?: OrderPolicy;
};

/** Default target service level (cover quantile) for the calibrated rule, by
 *  ABC class: protect the top-revenue sellers, lean on the mid-tier. */
function tauForClass(abc: string | null | undefined): number {
  if (abc === "B") return 0.9;
  return 0.95;
}

/** The calibrated cover protects demand over leadTimeAvg + the review period —
 *  the protection interval, NOT the cover window (which under-covered
 *  long-lead items: lead 28 > cover 21 meant running out before arrival). */
const REVIEW_DAYS = ORDER_REVIEW_DAYS;

export function recommendedQty(input: ReorderInput): number {
  const { finalForecast30d, safetyStock, currentStock, onOrder, policy } = input;

  const useMinMax = policy ? policy.rule === "min_max" : input.abcCategory === "C";

  const useCalibrated =
    !useMinMax &&
    policy?.rule === "calibrated" &&
    input.dailyDemandStd != null &&
    finalForecast30d > 0;

  if (useCalibrated) {
    const protectionDays = (input.leadTimeAvg ?? 0) + REVIEW_DAYS;
    const tau = policy?.serviceLevel ?? input.serviceLevel ?? tauForClass(input.abcCategory);
    const orderUpTo = calibratedCover({
      dailyMean: finalForecast30d / 30,
      dailyVar: input.dailyDemandStd! * input.dailyDemandStd!,
      horizonDays: protectionDays,
      tau,
    });
    return Math.max(0, Math.ceil(orderUpTo - currentStock - onOrder));
  }

  if (useMinMax) {
    // Min/max rule: maintain a par level of 2 weeks of demand + safety stock.
    // Never order a full month's worth for a SKU that might sell 3 units a month.
    const dailyRate = finalForecast30d / 30;
    const parLevel = Math.max(1, Math.ceil(dailyRate * 14 + safetyStock));
    return Math.max(0, parLevel - currentStock - onOrder);
  }

  const coverDays = input.coverDays ?? 30;
  const demandOverCover = (finalForecast30d / 30) * coverDays;
  return Math.max(0, Math.ceil(demandOverCover + safetyStock - currentStock - onOrder));
}

/** The method used for this item's recommendation — feeds Prediction.regime
 *  and the UI. When a per-class policy is supplied it decides; otherwise
 *  C -> min/max. */
export function reorderMethod(
  abcCategory: string | null | undefined,
  policy?: { rule: "calibrated" | "min_max" }
): "min_max" | "forecast" {
  if (policy) return policy.rule === "min_max" ? "min_max" : "forecast";
  return abcCategory === "C" ? "min_max" : "forecast";
}
