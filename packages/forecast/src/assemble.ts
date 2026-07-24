/**
 * Assembles a full ForecastResult from an external demand engine's output plus
 * the local inventory math. The demand fields pass through unchanged; safety
 * stock, reorder point, days-until-stockout, recommended qty, and urgency are
 * computed here from the same primitives the built-in engine uses — no
 * duplication, no drift between engines.
 */
import {
  kingsSafetyStock,
  reorderPoint,
  standardDeviation,
  zForServiceLevel,
  urgencyFromDays,
  daysOfStockRemaining,
  inferredStockoutGapDays,
  censoredDaysInWindow,
} from "./baseline";
import {
  anchorToday,
  historySpanDays,
  runRateDaily,
  type ForecastInput,
  type ForecastResult,
  type Signal,
} from "./layered";
import { confidenceWord, type ConfidenceSignals } from "./confidence-word";

/** Demand-only output from an external engine (e.g. a model service). */
export type DemandForecast = {
  layer1Forecast30d: number;
  layer1Confidence: number;
  layer2Adjustment: number;
  finalForecast30d: number;
  confidence: number;
  reasoning: string;
  signals: Signal[];
  regime?: string;
};

export function assembleForecastResult(
  input: ForecastInput,
  demand: DemandForecast
): ForecastResult {
  // Anchor on the tenant-local run day so two assemblies of the same run agree
  // regardless of wall-clock time.
  const today = anchorToday(input.runDateKey);

  // Daily rate: the same stockout-corrected production rate the built-in engine
  // uses; fall back to the demand forecast when history alone shows no rate.
  const rawRate = runRateDaily(input.history, today, input.stockoutDates);
  const dailyRate = rawRate > 0 ? rawRate : demand.finalForecast30d / 30;

  // Demand std from last 90 days of history.
  const last90Cutoff = new Date(today);
  last90Cutoff.setUTCDate(last90Cutoff.getUTCDate() - 90);
  const last90Pts = input.history.filter((p) => p.date >= last90Cutoff);
  const demandStd = standardDeviation(last90Pts.map((p) => p.quantity));

  // Confidence word from the same signal quality the built-in engine reads.
  const last30Cutoff = new Date(today);
  last30Cutoff.setUTCDate(last30Cutoff.getUTCDate() - 30);
  const recent30 = input.history.filter((p) => p.date >= last30Cutoff);
  const meanRecent =
    recent30.length > 0 ? recent30.reduce((s, p) => s + p.quantity, 0) / recent30.length : 0;
  const std90 = standardDeviation(last90Pts.map((p) => p.quantity));
  const cv = meanRecent > 0 ? std90 / meanRecent : 1.0;
  const stockoutGapDays = input.stockoutDates?.length
    ? censoredDaysInWindow(input.stockoutDates, last30Cutoff, today)
    : inferredStockoutGapDays(input.history, last30Cutoff, today);
  const confidenceSignals: ConfidenceSignals = {
    historyDays: historySpanDays(input.history, today),
    cv,
    stockoutGapShare: Math.max(0, Math.min(1, stockoutGapDays / 30)),
    promoContaminated: false, // the external engine folds promos into its own number
    coldStart: input.history.length === 0,
  };

  const z = zForServiceLevel(input.abcCategory, input.serviceZ);
  const safetyStock = kingsSafetyStock({
    z,
    leadTimeAvg: input.leadTimeAvg,
    leadTimeStd: input.leadTimeStd,
    demandAvg: dailyRate,
    demandStd,
  });

  const rop = reorderPoint(dailyRate, input.leadTimeAvg, safetyStock);
  const daysUntilStockout = daysOfStockRemaining(input.currentStock, dailyRate);

  const recommendedQty = Math.max(
    0,
    Math.ceil(demand.finalForecast30d + safetyStock - input.currentStock)
  );

  // Urgency from days until stockout, velocity-gated (slow movers at zero are
  // "high", not budget-overflowing "critical").
  const urgency = urgencyFromDays(daysUntilStockout, dailyRate);

  return {
    // Demand fields — passed through unchanged from the external engine
    layer1Forecast30d: demand.layer1Forecast30d,
    layer1Confidence: demand.layer1Confidence,
    layer2Adjustment: demand.layer2Adjustment,
    finalForecast30d: demand.finalForecast30d,
    confidence: demand.confidence,
    reasoning: demand.reasoning,
    signals: demand.signals,
    // Inventory math — computed here
    safetyStock,
    reorderPoint: rop,
    daysUntilStockout,
    recommendedQty,
    urgency,
    demandStd,
    confidenceWord: confidenceWord(confidenceSignals),
    confidenceSignals,
  };
}
