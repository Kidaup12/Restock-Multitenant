/**
 * Cost-moved detection (spec §4 "Cost moved sharply"): a SYNCED cost that jumps
 * more than ~20% versus its prior value raises an attention row so margins are
 * never silently rewritten by an FX swing on an import. Pure — the worker feeds
 * it the current synced cost and the stored baseline and acts on the verdict.
 */

/** A move beyond this magnitude (percent) is flagged. */
export const COST_MOVE_THRESHOLD_PCT = 20;

export type CostMoveInput = {
  /** The synced cost now (shopify/qb). */
  currentCostKes: number;
  /** The last synced cost the check saw — the prior-cost signal. Null = no
   *  baseline captured yet (first observation). */
  lastSyncedCostKes: number | null;
};

export type CostMove = {
  /** Signed percent change versus the baseline (e.g. 18, -22). */
  pct: number;
  /** True when |pct| exceeds the threshold — raise the attention row. */
  exceeded: boolean;
};

/**
 * Detect a synced-cost jump versus the stored baseline. Null when there is
 * nothing to judge: no baseline yet, a non-positive baseline, or a current cost
 * that isn't a real positive number (a zero/missing cost is never a "move" —
 * zero-as-missing, so a real cost is never wiped by a bad zero).
 */
export function detectCostMove(input: CostMoveInput): CostMove | null {
  const { currentCostKes, lastSyncedCostKes } = input;
  if (!(currentCostKes > 0)) return null;
  if (lastSyncedCostKes == null || !(lastSyncedCostKes > 0)) return null;
  const pct = ((currentCostKes - lastSyncedCostKes) / lastSyncedCostKes) * 100;
  return { pct, exceeded: Math.abs(pct) > COST_MOVE_THRESHOLD_PCT };
}

/** Whole-number signed percent for display: 18 → "+18%", -22 → "-22%". */
export function formatMovePct(pct: number): string {
  const r = Math.round(pct);
  return `${r > 0 ? "+" : ""}${r}%`;
}
