/**
 * Human-traceable breakdown of a reorder quantity: tap any recommended
 * quantity and see the simple math. Reuses recommendedQty() as the single
 * source of truth, so the total ALWAYS matches the number on the buy list.
 *
 * The line-by-line breakdown shows the mean-cover formula:
 *   ceil( (finalForecast30d / 30) x coverDays + safety - stock - incoming ), floored at 0
 * When the input carries a calibrated or min/max policy the TOTAL still comes
 * from recommendedQty (it never drifts from the UI number), but the parts sum
 * only for the mean-cover rule — callers explaining a policy-driven quantity
 * should present the summary, not the arithmetic.
 */
import { recommendedQty, type ReorderInput } from "./reorder";

export type QtyExplanation = {
  dailyForecast: number; // finalForecast30d / 30 — the capped run rate, per day
  coverDays: number;
  demandOverCover: number; // dailyForecast x coverDays
  safetyStock: number;
  currentStock: number;
  onOrder: number; // incoming / en-route
  recommendedQty: number;
  summary: string;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

export function explainQty(input: ReorderInput): QtyExplanation {
  const coverDays = input.coverDays ?? 30;
  const dailyForecast = input.finalForecast30d / 30;
  const demandOverCover = dailyForecast * coverDays;
  const qty = recommendedQty(input); // single source of truth — never drifts from the UI number
  const summary =
    `${r1(dailyForecast)}/day × ${coverDays}d (${r1(demandOverCover)})` +
    ` + buffer ${r1(input.safetyStock)}` +
    ` − ${r1(input.currentStock)} in stock` +
    ` − ${r1(input.onOrder)} incoming` +
    ` = ${qty}`;
  return {
    dailyForecast,
    coverDays,
    demandOverCover,
    safetyStock: input.safetyStock,
    currentStock: input.currentStock,
    onOrder: input.onOrder,
    recommendedQty: qty,
    summary,
  };
}
