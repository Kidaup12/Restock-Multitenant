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
}): GuardrailDecision {
  const { finalForecast30d, sold30, historySpanDays, currentStock } = input;

  // Too young to judge — the estimate is all we have.
  if (historySpanDays < 30) return { finalForecast30d, capped: false };

  // Heavily censored window (out >7 of 30 days): recent sales are not a fair
  // yardstick — the forecast is allowed to exceed them (that's the point of
  // stockout correction).
  if ((input.stockoutDays30 ?? 0) > 7) return { finalForecast30d, capped: false };

  if (sold30 > 0) {
    const cap = GUARDRAIL_MULTIPLIER * sold30;
    if (finalForecast30d > cap) return { finalForecast30d: cap, capped: true };
    return { finalForecast30d, capped: false };
  }

  // Zero sales in 30d. An empty shelf can't sell — censored, leave alone.
  if (currentStock <= 0) return { finalForecast30d, capped: false };

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
  const signal: Signal = {
    label: `Reality check: forecast capped to ${GUARDRAIL_MULTIPLIER}× recent sales (sold ${Math.round(sold30)} in 30d)`,
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
