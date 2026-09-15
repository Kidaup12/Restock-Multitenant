/**
 * Reality guardrail for demand forecasts — engine-agnostic.
 *
 * Whatever produced the 30-day demand estimate, it must stay within shouting
 * distance of what the item ACTUALLY sold recently. A cap of 3x recent sales
 * catches any engine edge case that inflates the buy list, regardless of which
 * engine misfires.
 *
 * Deliberately NOT clamped: items out of stock that sold nothing (their zero
 * sales are censored — demand for an empty shelf is invisible) and items with
 * under 30 days of history (too young to judge; the estimate is the only
 * signal there is).
 */
import type { ForecastResult, Signal } from "./layered";
import type { SalesPoint } from "./baseline";

/** Forecast may exceed recent actual sales by at most this factor. Generous on
 *  purpose — real spikes/trends fit inside 3x; only fantasy numbers don't. */
export const GUARDRAIL_MULTIPLIER = 3;

/** Cap for an in-stock item that sold NOTHING in 30 days: a token allowance so
 *  slow-but-alive items aren't zeroed, without funding a dead one. */
const ZERO_SALES_CAP_30D = 3;

/** Absolute 30-day ceiling for a thin-data item — one with under 30 days of
 *  history, or so heavily out of stock that recent sales can't be the 3× yardstick.
 *  Recent sales can't bound the forecast in those cases, but the number still
 *  can't be pure fantasy: a cold-start borrow or a censored rate could otherwise
 *  print 90 units on a shelf that has moved almost nothing. Cap at the larger of
 *  3× what it DID sell and this ceiling — a real breakout has room, cold-start
 *  inflation gets cut. Set to a month of the Class-A rate floor (0.4/day × 30 = 12)
 *  so a legitimately floored bestseller is never clipped below its own floor. */
export const THIN_DATA_ABSOLUTE_CAP_30D = 12;

export type GuardrailDecision = {
  /** The (possibly clamped) 30-day forecast. */
  finalForecast30d: number;
  capped: boolean;
};

export function guardrailCap(input: {
  finalForecast30d: number;
  sold30: number;
  historySpanDays: number;
  currentStock: number;
  /** Proven out-of-stock days within the last 30 — when the shelf was empty a
   *  big chunk of the window, sold30 understates demand and can't be a cap. */
  stockoutDays30?: number;
  /** Owner override of the thin-data ceiling. Defaults to the shipped constant. */
  thinCap?: number;
}): GuardrailDecision {
  const { finalForecast30d, sold30, historySpanDays, currentStock } = input;
  const THIN = input.thinCap ?? THIN_DATA_ABSOLUTE_CAP_30D;

  // Thin data: under 30 days of history, or so heavily censored (out >7 of 30
  // days) that sold30 understates demand. Recent sales can't be the 3× yardstick
  // here — but the forecast still can't be fantasy, so cap at the larger of
  // 3× what it DID sell and the thin-data ceiling. (These two branches used to
  // return uncapped, which is exactly how cold-start / borrowed inflation leaked
  // a huge number onto the buy list.)
  const thin = historySpanDays < 30 || (input.stockoutDays30 ?? 0) > 7;
  if (thin) {
    const cap = Math.max(GUARDRAIL_MULTIPLIER * sold30, THIN);
    if (finalForecast30d > cap) return { finalForecast30d: cap, capped: true };
    return { finalForecast30d, capped: false };
  }

  if (sold30 > 0) {
    const cap = GUARDRAIL_MULTIPLIER * sold30;
    if (finalForecast30d > cap) return { finalForecast30d: cap, capped: true };
    return { finalForecast30d, capped: false };
  }

  // Zero sales in 30d, out of stock but not heavily censored (≤7 stockout days,
  // ≥30d history). An empty shelf can't sell, so we don't zero it — but a big
  // forecast is still fantasy, so hold it to the thin-data ceiling rather than
  // letting it run unbounded (the old leak).
  if (currentStock <= 0) {
    if (finalForecast30d > THIN) return { finalForecast30d: THIN, capped: true };
    return { finalForecast30d, capped: false };
  }

  // On the shelf, sold nothing -> any big forecast is fantasy.
  if (finalForecast30d > ZERO_SALES_CAP_30D) {
    return { finalForecast30d: ZERO_SALES_CAP_30D, capped: true };
  }
  return { finalForecast30d, capped: false };
}

/**
 * Apply the guardrail to a full ForecastResult: clamp the demand, scale the
 * demand-derived fields by the same ratio (safety stock, demand std), recompute
 * days-until-stockout from the corrected rate, and stamp a visible signal so
 * the UI can show WHY the number differs from the engine's raw output.
 */
export function guardForecastResult(
  result: ForecastResult,
  ctx: { history: SalesPoint[]; currentStock: number; today: Date; stockoutDates?: Date[] }
): ForecastResult {
  const { history, currentStock, today } = ctx;

  const since30 = new Date(today);
  since30.setUTCDate(since30.getUTCDate() - 30);
  let sold30 = 0;
  let earliest: Date | null = null;
  for (const p of history) {
    if (p.date >= since30) sold30 += p.quantity;
    if (earliest === null || p.date < earliest) earliest = p.date;
  }
  const spanDays = earliest ? (+today - +earliest) / 864e5 : 0;
  let stockoutDays30 = 0;
  for (const d of ctx.stockoutDates ?? []) if (d >= since30 && d < today) stockoutDays30++;

  const decision = guardrailCap({
    finalForecast30d: result.finalForecast30d,
    sold30,
    historySpanDays: spanDays,
    currentStock,
    stockoutDays30,
  });
  if (!decision.capped || result.finalForecast30d <= 0) return result;

  const ratio = decision.finalForecast30d / result.finalForecast30d;
  const newRate = decision.finalForecast30d / 30;
  // The cap that actually bit: 3× recent sales for a normal item, or the
  // thin-data ceiling when history is short / the shelf was mostly empty.
  const thin = spanDays < 30 || stockoutDays30 > 7 || sold30 === 0;
  const label = thin
    ? `Reality check: forecast held to ${Math.round(decision.finalForecast30d)} on thin data (sold ${Math.round(sold30)} in 30d)`
    : `Reality check: forecast capped to ${GUARDRAIL_MULTIPLIER}× recent sales (sold ${Math.round(sold30)} in 30d)`;
  const signal: Signal = {
    label,
    deltaPct: (ratio - 1) * 100,
    emoji: "🛡️",
  };
  return {
    ...result,
    finalForecast30d: decision.finalForecast30d,
    safetyStock: result.safetyStock * ratio,
    demandStd: result.demandStd != null ? result.demandStd * ratio : result.demandStd,
    daysUntilStockout: newRate > 0 ? Math.floor(currentStock / newRate) : result.daysUntilStockout,
    signals: [...result.signals, signal],
  };
}
