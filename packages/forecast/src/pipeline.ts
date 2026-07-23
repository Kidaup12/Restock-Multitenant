/**
 * Per-product forecast pipeline: plain product/supplier facts + sales history
 * in, the full Prediction field set out. Composes the layered forecast, the
 * reality guardrail, and the policy-driven reorder sizing so callers persist
 * one shape and never re-derive the math.
 *
 * Cross-product steps stay with the caller: ABC assignment needs the whole
 * catalog (dailySalesValue + assignAbc), promo windows need the tenant's promo
 * table, and the stockout mask comes from inventory snapshots.
 */
import type { SalesPoint, Urgency } from "./baseline";
import { anchorToday, layeredForecast, type ActivePromo, type Signal } from "./layered";
import { guardForecastResult } from "./guardrail";
import { recommendedQty, reorderMethod } from "./reorder";
import { leadDaysFor, leadStdFor, coverDaysFor } from "./lead-time";
import type { OrderPolicy } from "./config";

export type ProductFacts = {
  sku: string;
  productType?: string | null;
  vendor?: string | null;
  currentStock: number;
  onOrder: number;
  /** Per-product lead-time override (days); null/absent -> supplier average. */
  leadTimeDays?: number | null;
  /** Unit economics — not used by the forecast itself; carried for the ABC
   *  value and plannability checks that live alongside this pipeline. */
  priceKes?: number;
  costKes?: number;
};

export type SupplierFacts = {
  leadTimeAvgDays?: number | null;
  leadTimeStdDays?: number | null;
};

export type ProductForecastInput = {
  productId: string;
  product: ProductFacts;
  supplier?: SupplierFacts | null;
  history: SalesPoint[];
  /** Proven out-of-stock day-keys (UTC midnight) for censored-demand correction. */
  stockoutDates?: Date[];
  activePromos?: ActivePromo[];
  abcCategory?: string | null;
  /** Resolved ordering policy for this product's class (config.policyForClass). */
  policy?: OrderPolicy;
  /** Per-class z overrides for safety stock (tenant setting). */
  serviceZ?: Partial<Record<"A" | "B" | "C", number | null>>;
  /** Forecast cap multiple over the best trailing month (tenant setting). */
  capMultiple?: number;
  /** Tenant-local run day (YYYY-MM-DD) anchoring all date math. */
  runDateKey?: string;
};

/** The Prediction row fields the engine is responsible for. `signals` stays
 *  structured — persist it as JSON at the boundary. */
export type PredictionFields = {
  layer1Forecast30d: number;
  layer1Confidence: number;
  layer2Adjustment: number;
  finalForecast30d: number;
  daysUntilStockout: number;
  recommendedQty: number;
  safetyStock: number;
  reorderPoint: number;
  confidence: number;
  reasoning: string;
  urgency: Urgency;
  signals: Signal[];
  regime: "min_max" | "forecast";
};

export function forecastProduct(input: ProductForecastInput): PredictionFields {
  const { product, supplier } = input;
  const today = anchorToday(input.runDateKey);

  // Lead precedence: product override -> supplier average; no real data -> 0
  // (review-cycle-only protection — never a guessed lead).
  const leadTimeAvg = leadDaysFor(product, supplier) ?? 0;
  const leadTimeStd = leadStdFor(supplier);

  const result = guardForecastResult(
    layeredForecast({
      productId: input.productId,
      productType: product.productType ?? null,
      vendor: product.vendor ?? null,
      sku: product.sku,
      currentStock: product.currentStock,
      abcCategory: input.abcCategory ?? null,
      history: input.history,
      leadTimeAvg,
      leadTimeStd,
      activePromos: input.activePromos ?? [],
      runDateKey: input.runDateKey,
      stockoutDates: input.stockoutDates,
      serviceZ: input.serviceZ,
      capMultiple: input.capMultiple,
    }),
    {
      history: input.history,
      currentStock: product.currentStock,
      today,
      stockoutDates: input.stockoutDates,
    }
  );

  // Order sizing: the policy (or ABC fallback) picks the rule; the cover
  // window comes from the item's own lead + review cycle.
  const qty = recommendedQty({
    finalForecast30d: result.finalForecast30d,
    safetyStock: result.safetyStock,
    currentStock: product.currentStock,
    onOrder: product.onOrder,
    abcCategory: input.abcCategory,
    coverDays: coverDaysFor(product, supplier),
    dailyDemandStd: result.demandStd,
    leadTimeAvg,
    policy: input.policy,
  });

  // A dead or brand-new listing keeps the engine's zero recommendation — the
  // reorder rules only apply to items with a real run rate.
  const engineSaysZero = result.recommendedQty === 0 && result.finalForecast30d <= 0;

  return {
    layer1Forecast30d: result.layer1Forecast30d,
    layer1Confidence: result.layer1Confidence,
    layer2Adjustment: result.layer2Adjustment,
    finalForecast30d: result.finalForecast30d,
    daysUntilStockout: result.daysUntilStockout,
    recommendedQty: engineSaysZero ? 0 : qty,
    safetyStock: result.safetyStock,
    reorderPoint: result.reorderPoint,
    confidence: result.confidence,
    reasoning: result.reasoning,
    urgency: result.urgency,
    signals: result.signals,
    regime: reorderMethod(input.abcCategory, input.policy),
  };
}
