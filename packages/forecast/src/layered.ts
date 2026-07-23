/**
 * Two-layer demand forecast.
 *
 * Layer 1 is a recency-weighted run rate — walk-forward backtesting on real
 * shop data showed it beats fancier models on this kind of intermittent retail
 * demand. Layer 2 applies owner-entered promo lifts (knowledge, not guesses)
 * and a hard cap at a multiple of the product's best trailing month so no
 * engine edge case can produce a runaway order.
 *
 * Pure: every fact the forecast depends on arrives as data on ForecastInput.
 */
import {
  weightedDailyRateAdjusted,
  weightedDailyRateCensored,
  censoredDaysInWindow,
  effectiveWindowDays,
  daysOfStockRemaining,
  kingsSafetyStock,
  reorderPoint,
  standardDeviation,
  urgencyFromDays,
  zForServiceLevel,
  type SalesPoint,
  type Urgency,
} from "./baseline";

export type ActivePromo = {
  discountPct: number;
  promoType: string;
  channel: string;
  /** "all" | "sku" | "category" | "brand" */
  scope: string;
  scopeValue: string | null;
};

export type ForecastInput = {
  productId: string;
  productType: string | null;
  vendor: string | null;
  sku: string;
  currentStock: number;
  abcCategory: string | null;
  history: SalesPoint[];
  /** Real lead-time average (days). 0 = no lead data — never a guess. */
  leadTimeAvg: number;
  leadTimeStd: number;
  activePromos: ActivePromo[];
  /**
   * Tenant-local calendar day (YYYY-MM-DD) that anchors all internal date math.
   * When supplied, two runs at different UTC instants within the same tenant
   * day produce identical output. Absent -> wall-clock UTC midnight.
   */
  runDateKey?: string;
  /**
   * Day-keys (UTC midnight) inventory snapshots PROVE the shelf was empty —
   * censored days excluded from rate denominators (zero sales that day mean
   * "couldn't sell", not "no demand"). Absent/empty -> gap-inference fallback.
   */
  stockoutDates?: Date[];
  /** Per-class z overrides for safety stock (tenant setting). Absent -> defaults. */
  serviceZ?: Partial<Record<"A" | "B" | "C", number | null>>;
  /** Cap multiple over the best trailing month (tenant setting). Absent -> 3. */
  capMultiple?: number;
};

/** No forecast may exceed this multiple of the product's best trailing month.
 *  Kills runaway forecasts at zero accuracy cost (backtest-verified). */
export const DEFAULT_CAP_MULTIPLE = 3;

/** Under this many days of history a product is "new": rate over its own short
 *  window only. Longer windows divide by days the product didn't exist and
 *  under-forecast. */
export const NEW_PRODUCT_DAYS = 60;

/** Confidence ceilings for thin history — a young product must not report the
 *  same certainty as one with a season of data behind it. */
const NEW_PRODUCT_MAX_CONFIDENCE = 0.5;
const NO_HISTORY_CONFIDENCE = 0.3;

/** Anchor "today" on the tenant-local day key when present, else wall-clock UTC midnight. */
export function anchorToday(runDateKey?: string): Date {
  if (runDateKey) return new Date(`${runDateKey}T00:00:00Z`);
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

export type Signal = { label: string; deltaPct: number; emoji: string };

export type ForecastResult = {
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
  /** Std dev of recent daily demand — feeds the calibrated reorder path. */
  demandStd?: number;
};

/** Days of history available as of `today` (0 when there is none). */
export function historySpanDays(history: SalesPoint[], today: Date): number {
  if (history.length === 0) return 0;
  let earliest = history[0]!.date;
  for (const p of history) if (p.date < earliest) earliest = p.date;
  return (+today - +earliest) / 864e5;
}

/** Plain mean daily rate over the trailing `windowDays` before `today`.
 *  Censored (proven out-of-stock) days come out of the denominator, and the
 *  floor adapts to signal quality (effectiveWindowDays). */
function rateOverWindow(history: SalesPoint[], today: Date, windowDays: number, stockoutDates?: Date[]): number {
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - windowDays);
  const inWindow = history.filter((p) => p.date >= since && p.date < today);
  const qty = inWindow.reduce((s, p) => s + p.quantity, 0);
  const censored = stockoutDates?.length ? censoredDaysInWindow(stockoutDates, since, today) : 0;
  const saleDays = inWindow.filter((p) => p.quantity > 0).length;
  const signal = stockoutDates?.length
    ? { inStockDays: windowDays - censored, saleDays }
    : undefined;
  return qty / effectiveWindowDays(windowDays, censored, signal);
}

/**
 * The production demand rate (units/day):
 *   <60 days of history -> mean over the product's own short window
 *   otherwise           -> recency-weighted 30/90/365-day blend
 * For a new product the window is clamped to the observed history span
 * (floored at 7 days) — dividing a 10-day-old product's sales by a fixed 30
 * would silently under-forecast it 3x. Snapshot-proven stockout days are
 * excluded from denominators when the mask is provided; otherwise the
 * gap-inference fallback covers pre-snapshot history.
 */
export function runRateDaily(history: SalesPoint[], today: Date, stockoutDates?: Date[]): number {
  const span = historySpanDays(history, today);
  if (span < NEW_PRODUCT_DAYS) {
    const window = Math.min(30, Math.max(7, Math.ceil(span)));
    return rateOverWindow(history, today, window, stockoutDates);
  }
  return stockoutDates?.length
    ? weightedDailyRateCensored(history, stockoutDates, today)
    : weightedDailyRateAdjusted(history, today); // gap inference when no snapshot mask
}

/** Largest single calendar-month sales total in the history before `today` (0 if none). */
function bestTrailingMonth(history: SalesPoint[], today: Date): number {
  const byMonth = new Map<string, number>();
  for (const p of history) {
    if (p.date >= today) continue;
    const key = p.date.toISOString().slice(0, 7); // YYYY-MM
    byMonth.set(key, (byMonth.get(key) ?? 0) + p.quantity);
  }
  return byMonth.size ? Math.max(...byMonth.values()) : 0;
}

/** Best matching promo lift for this product: discount% x 1.5 elasticity. */
function activePromoLift(
  promos: ActivePromo[],
  productType: string | null,
  vendor: string | null,
  sku: string
): { lift: number; channel: string | null } {
  let bestLift = 1.0;
  let channel: string | null = null;
  for (const p of promos) {
    const matches =
      p.scope === "all" ||
      (p.scope === "sku" && p.scopeValue === sku) ||
      (p.scope === "category" && p.scopeValue && p.scopeValue.toUpperCase() === (productType ?? "").toUpperCase()) ||
      (p.scope === "brand" && p.scopeValue && p.scopeValue.toUpperCase() === (vendor ?? "").toUpperCase());
    if (!matches) continue;
    const lift = 1 + (p.discountPct / 100) * 1.5;
    if (lift > bestLift) {
      bestLift = lift;
      channel = p.channel;
    }
  }
  return { lift: bestLift, channel };
}

export function layeredForecast(input: ForecastInput): ForecastResult {
  const today = anchorToday(input.runDateKey);
  const span = historySpanDays(input.history, today);
  const isNew = span < NEW_PRODUCT_DAYS;
  const hasHistory = input.history.length > 0;

  // ── Layer 1: recency-weighted run rate ────────────────────────────────────
  const dailyRate = runRateDaily(input.history, today, input.stockoutDates);
  const layer1 = dailyRate * 30;

  // ── Confidence: coefficient of variation of recent demand, capped for thin
  //    history so a week of data never reads as certainty ────────────────────
  const last30 = new Date(today);
  last30.setUTCDate(last30.getUTCDate() - 30);
  const last90 = new Date(today);
  last90.setUTCDate(last90.getUTCDate() - 90);
  const recent = input.history.filter((p) => p.date >= last30);
  const last90Pts = input.history.filter((p) => p.date >= last90);
  const meanRecent = recent.length > 0 ? recent.reduce((s, p) => s + p.quantity, 0) / recent.length : 0;
  const std90 = standardDeviation(last90Pts.map((p) => p.quantity));
  const cv = meanRecent > 0 ? std90 / meanRecent : 1.0;
  let layer1Confidence = Math.max(0.3, Math.min(0.95, 0.9 - cv * 0.3));
  if (!hasHistory) layer1Confidence = NO_HISTORY_CONFIDENCE;
  else if (isNew) layer1Confidence = Math.min(layer1Confidence, NEW_PRODUCT_MAX_CONFIDENCE);

  // ── Layer 2: owner-entered promos only. Calendar guesses (holiday/payday)
  //    were removed — backtesting showed they hurt accuracy without a full
  //    season of history to learn from. An explicit "20% off next week" is
  //    knowledge, not a guess, so it lifts the forecast; the cap still bounds it.
  const signals: Signal[] = [];
  let boosted = layer1;

  const promo = activePromoLift(input.activePromos, input.productType, input.vendor, input.sku);
  if (promo.lift > 1.01) {
    signals.push({
      label: `Active promo ${promo.channel ?? ""} +${((promo.lift - 1) * 100).toFixed(0)}%`,
      deltaPct: (promo.lift - 1) * 100,
      emoji: "🏷️",
    });
    boosted = boosted * promo.lift;
  }

  // ── Safety cap: never exceed capMultiple x the best trailing month ────────
  const capMultiple = input.capMultiple ?? DEFAULT_CAP_MULTIPLE;
  const best = bestTrailingMonth(input.history, today);
  const cap = best > 0 ? capMultiple * best : Infinity;
  const capped = Math.min(boosted, cap);
  const wasCapped = capped < boosted - 1e-9;
  if (wasCapped) {
    signals.push({
      label: `Capped at ${capMultiple}× best month`,
      deltaPct: ((capped - boosted) / boosted) * 100,
      emoji: "✂️",
    });
  }

  const finalForecast30d = Math.max(0, capped);
  const layer2Adjustment = finalForecast30d - layer1;

  // ── Inventory math (anchored on the same day-aware daily rate) ────────────
  const demandStd = standardDeviation(last90Pts.map((p) => p.quantity));
  const z = zForServiceLevel(input.abcCategory, input.serviceZ);
  const safety = kingsSafetyStock({
    z,
    leadTimeAvg: input.leadTimeAvg,
    leadTimeStd: input.leadTimeStd,
    demandAvg: dailyRate,
    demandStd,
  });
  const rop = reorderPoint(dailyRate, input.leadTimeAvg, safety);
  const daysLeft = daysOfStockRemaining(input.currentStock, dailyRate);

  // A product with sales history but no run rate is a dead listing: never
  // recommended, never counted as a stockout, even at zero stock. A product
  // with NO history at all is not dead — it's too new to judge, and the result
  // must say so instead of silently reading as "not selling".
  const isDead = hasHistory && dailyRate <= 0;
  const tooNew = !hasHistory;
  if (tooNew) {
    signals.push({ label: "New product — no sales history yet", deltaPct: 0, emoji: "🆕" });
  } else if (isNew) {
    signals.push({
      label: `New product — forecast from ${Math.max(1, Math.round(span))} days of history`,
      deltaPct: 0,
      emoji: "🆕",
    });
  }
  const urgency: Urgency = isDead || tooNew ? "low" : urgencyFromDays(daysLeft, dailyRate);
  const recommendedQty =
    isDead || tooNew ? 0 : Math.max(0, Math.ceil(finalForecast30d + safety - input.currentStock));

  const reasoning = (tooNew
    ? [
        "No sales history yet — too new to forecast; collect sales before ordering against a prediction.",
        `Current stock ${input.currentStock}.`,
      ]
    : [
        `Forecast ${finalForecast30d.toFixed(0)} units over 30 days from the ${
          isNew ? `last-${Math.max(1, Math.round(span))}-day rate (new product)` : "recency-weighted run rate (30/90/365-day blend)"
        }: ${dailyRate.toFixed(2)} units/day.`,
        wasCapped ? `Capped at ${capMultiple}× the best month (${best.toFixed(0)}) to block runaway numbers.` : "",
        `Safety stock ${safety.toFixed(0)} (${input.abcCategory ?? "C"}-class service, z=${z}, lead time ${input.leadTimeAvg}±${input.leadTimeStd}d); reorder point ${rop.toFixed(0)}.`,
        `Current stock ${input.currentStock} covers ~${daysLeft} days.`,
      ]
  )
    .filter(Boolean)
    .join(" ");

  return {
    layer1Forecast30d: layer1,
    layer1Confidence,
    layer2Adjustment,
    finalForecast30d,
    daysUntilStockout: daysLeft,
    recommendedQty,
    safetyStock: safety,
    reorderPoint: rop,
    confidence: layer1Confidence,
    reasoning,
    urgency,
    signals,
    demandStd,
  };
}
