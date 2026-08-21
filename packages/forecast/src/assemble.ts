/**
 * Assembles a full ForecastResult from an external demand engine's output plus
 * the local inventory math. The demand fields pass through unchanged; safety
 * stock, reorder point, days-until-stockout, recommended qty, and urgency are
 * computed here from the same primitives the built-in engine uses.
 *
 * "Same primitives" is not the same as "no drift": this file re-implements the
 * assembly around them, so a rule added to the built-in engine has to be added
 * here by hand. That is exactly how the two came apart once already — the
 * built-in engine learned to size the shelf on a stated season while this one
 * went on sizing it from raw history. Anything that changes how a lift reaches
 * the reorder point, cover or urgency has to change in both.
 *
 * Nothing calls this today; it is the seam for an external demand engine.
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
  const rawRate = runRateDaily(
    input.history,
    today,
    input.stockoutDates,
    input.excludedDates,
    input.snapshotsSince
  );
  const dailyRate = rawRate > 0 ? rawRate : demand.finalForecast30d / 30;

  // The rate the shelf math runs on. Whatever the demand engine added over its
  // own baseline — a season, a promo, a regime — has to reach cover, the reorder
  // point and urgency too, not just the order quantity, or the buy list sizes
  // for a busy month while the trigger that fires it waits for a normal one.
  // The built-in engine sizes the shelf on the same lift it ordered on; this is
  // that rule, on the demand another engine hands us.
  //
  // Only when the history rate is what we are scaling: on the fallback path
  // dailyRate IS the engine's final number, so applying the lift again would
  // count it twice.
  const lift =
    rawRate > 0 && demand.layer1Forecast30d > 0
      ? demand.finalForecast30d / demand.layer1Forecast30d
      : 1;
  const sizingDailyRate = dailyRate * lift;

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
    demandAvg: sizingDailyRate,
    demandStd,
  });

  const rop = reorderPoint(sizingDailyRate, input.leadTimeAvg, safetyStock);
  const daysUntilStockout = daysOfStockRemaining(input.currentStock, sizingDailyRate);

  const recommendedQty = Math.max(
    0,
    Math.ceil(demand.finalForecast30d + safetyStock - input.currentStock)
  );

  // Urgency from days until stockout, velocity-gated (slow movers at zero are
  // "high", not budget-overflowing "critical").
  const urgency = urgencyFromDays(daysUntilStockout, sizingDailyRate);

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
