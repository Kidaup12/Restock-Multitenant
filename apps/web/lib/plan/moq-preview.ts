import type { BuyListRow } from "@/lib/data/plan";
import { applyMoq } from "@/lib/po/po-math";

/**
 * Read-only preview of what the supplier MOQ floor does to a buy-list line.
 *
 * The real floor is applied at PO creation (`applyMoq` in po-math); this mirrors
 * it so the plan can show, before anyone commits, when a supplier minimum forces
 * an over-order. Quantities only — no money — so it is safe for every role.
 */

const DAYS_PER_MONTH = 30;

/** A MOQ floor that buys roughly this many months of cover (or more) is worth
 *  flagging: the shop is tying up cash in stock it won't move for a third of a
 *  year, purely to clear the supplier's minimum. */
export const BAD_MOQ_MONTHS = 4;

/** The fields moqPreview needs — a structural subset of BuyListRow. */
export type MoqPreviewInput = Pick<
  BuyListRow,
  "recommendedQty" | "overriddenQty" | "moq" | "runRatePerDay"
>;

export type MoqPreview = {
  /** The qty we'd actually buy: the override or the engine's number. */
  effectiveQty: number;
  /** That qty raised to the supplier's MOQ floor. */
  flooredQty: number;
  /** True when the MOQ floor pushed the order above what we'd otherwise buy. */
  roundedUp: boolean;
  /** Months the floored qty covers at the current run rate; null when the item
   *  has no run rate to divide by. */
  monthsOfCover: number | null;
  /** The MOQ floor buys an uncomfortably long run of cover (~>= BAD_MOQ_MONTHS). */
  badMoq: boolean;
};

export function moqPreview(row: MoqPreviewInput): MoqPreview {
  const effectiveQty = row.overriddenQty ?? row.recommendedQty;
  const flooredQty = applyMoq(effectiveQty, row.moq);
  const roundedUp = flooredQty > effectiveQty;

  const runRatePerMonth = row.runRatePerDay * DAYS_PER_MONTH;
  const monthsOfCover = runRatePerMonth > 0 ? flooredQty / runRatePerMonth : null;

  const badMoq = roundedUp && monthsOfCover !== null && monthsOfCover >= BAD_MOQ_MONTHS;

  return { effectiveQty, flooredQty, roundedUp, monthsOfCover, badMoq };
}
