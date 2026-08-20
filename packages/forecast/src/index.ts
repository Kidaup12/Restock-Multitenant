// Demand rates + inventory primitives
export {
  weightedDailyRate,
  weightedDailyRateAdjusted,
  weightedDailyRateCensored,
  dampedWindow,
  median,
  SPIKE_CAP_MULTIPLE,
  MIN_SALE_DAYS_FOR_CAP,
  censoredDaysInWindow,
  effectiveWindowDays,
  hasStockoutGap,
  daysOfStockRemaining,
  NO_STOCKOUT_DAYS,
  kingsSafetyStock,
  reorderPoint,
  standardDeviation,
  urgencyFromDays,
  zForServiceLevel,
  SERVICE_Z_DEFAULTS,
  type SalesPoint,
  type Urgency,
} from "./baseline";

// Two-layer forecast engine
export {
  layeredForecast,
  runRateDaily,
  historySpanDays,
  anchorToday,
  DEFAULT_CAP_MULTIPLE,
  NEW_PRODUCT_DAYS,
  type ForecastInput,
  type ForecastResult,
  type ActivePromo,
  type DemandOverride,
  type Signal,
} from "./layered";

// Confidence vocabulary — the honesty word on every number
export {
  confidenceWord,
  leastConfident,
  SURE_MIN_HISTORY_DAYS,
  GUESS_MAX_HISTORY_DAYS,
  type ConfidenceWord,
  type ConfidenceSignals,
} from "./confidence-word";

// Cold start — borrow-from-similar (established proxies only)
export {
  selectProxy,
  isEstablishedProxy,
  borrowedDailyRate,
  borrowedForecast30d,
  PROXY_MIN_HISTORY_DAYS,
  type ProxyCandidate,
  type ProxyTarget,
} from "./cold-start";

// Owner priors — "tell the forecast something"
export {
  priorActive,
  priorMatchesProduct,
  selectPriorForProduct,
  applyOwnerPrior,
  OWNER_PRIOR_MAX_MULTIPLIER,
  type PriorScope,
  type OwnerPriorFacts,
  type PriorProduct,
} from "./owner-prior";

// Walk-forward backtest + champion/challenger audition
export {
  walkForwardBacktest,
  walkForwardCutoffs,
  methodDailyRate,
  auditChampion,
  championsByClass,
  DEMAND_METHODS,
  CHAMPION_DEFAULT,
  CHALLENGER_WIN_MARGIN,
  type DemandMethod,
  type BacktestProduct,
  type BacktestResult,
  type ClassAccuracy,
  type Lean,
} from "./backtest";

// Reality guardrail
export {
  guardrailCap,
  guardForecastResult,
  GUARDRAIL_MULTIPLIER,
  type GuardrailDecision,
} from "./guardrail";

// External-engine assembly
export { assembleForecastResult, type DemandForecast } from "./assemble";

// Reorder sizing
export { recommendedQty, reorderMethod, type ReorderInput } from "./reorder";
export { explainQty, type QtyExplanation } from "./explain";
export {
  countQuantile,
  calibratedCover,
  type CalibratedCoverInput,
} from "./calibrated-quantile";

// Lead-time / cover resolution
export {
  leadDaysFor,
  leadStdFor,
  coverDaysFor,
  ORDER_REVIEW_DAYS,
  ASSUMED_LEAD_DAYS,
  type ProductLeadFacts,
  type SupplierLeadFacts,
} from "./lead-time";

// ABC classification
export { assignAbc, dailySalesValue, type AbcInput, type AbcCategory } from "./abc";

// Tenant config resolution (pure)
export {
  methodToPolicy,
  parseOrderMethod,
  resolveForecastKnobs,
  policyForClass,
  resolveChampions,
  championForClass,
  ORDER_METHODS,
  METHOD_DEFAULTS,
  type OrderMethod,
  type OrderPolicy,
  type TenantForecastOverrides,
  type ResolvedForecastKnobs,
} from "./config";

// Promo handling
export {
  promoMatchesProduct,
  windowsForProduct,
  excludePromoDays,
  expandPromoWindowsToDays,
  type PromoWindow,
  type ProductMatch,
} from "./promo-windows";
export { detectSpikes, SPIKE_MULTIPLE, type Spike, type SpikePromoWindow } from "./spike-detect";

// Buy-list helpers
export { allocateByBudget, type Allocatable, type Allocation } from "./allocate";
export { plannableReason, isPlannable, type CostShape, type PlannableReason } from "./plannable";
export { overstockExcess } from "./overstock";

// Full per-product pipeline
export {
  forecastProduct,
  type ProductForecastInput,
  type ProductFacts,
  type SupplierFacts,
  type PredictionFields,
} from "./pipeline";
export {
  blendedSeasonalMultiplier,
  boundedMultiplier,
  monthKeyOf,
  seasonalLabel,
  SEASONAL_HORIZON_DAYS,
  SEASONAL_MAX,
  SEASONAL_MIN,
  type MonthlyExpectation,
} from "./seasonality";
