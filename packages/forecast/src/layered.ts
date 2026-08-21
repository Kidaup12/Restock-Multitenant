/**
 * Two-layer demand forecast.
 *
 * Layer 1 is a recency-weighted run rate — walk-forward backtesting on real
 * shop data showed it beats fancier models on this kind of intermittent retail
 * demand. Layer 2 applies what the OWNER has told us — promo lifts and stated
 * monthly seasonality, knowledge rather than guesses — and a hard cap at a
 * multiple of the product's best trailing month so no engine edge case can
 * produce a runaway order.
 *
 * Pure: every fact the forecast depends on arrives as data on ForecastInput.
 */
import {
  weightedDailyRateAdjusted,
  weightedDailyRateCensored,
  censoredDaysInWindow,
  blockedDaysInWindow,
  dayKeyOf,
  inferredStockoutGapDays,
  effectiveWindowDays,
  dampedWindow,
  daysOfStockRemaining,
  kingsSafetyStock,
  NO_STOCKOUT_DAYS,
  reorderPoint,
  standardDeviation,
  urgencyFromDays,
  zForServiceLevel,
  type SalesPoint,
  type Urgency,
} from "./baseline";
import {
  confidenceWord,
  leastConfident,
  type ConfidenceSignals,
  type ConfidenceWord,
} from "./confidence-word";
import {
  blendedSeasonalMultiplier,
  seasonalLabel,
  type MonthlyExpectation,
} from "./seasonality";

export type ActivePromo = {
  discountPct: number;
  promoType: string;
  channel: string;
  /** "all" | "sku" | "category" | "brand" */
  scope: string;
  scopeValue: string | null;
};

/**
 * An external demand level (30-day units) that REPLACES the history-derived run
 * rate: a cold-start borrow-from-similar, or an owner "I expect about X". Layer 2
 * cap/promo is bypassed for it (the override IS the stated demand), but the
 * sizing, inventory, and confidence math still run. Borrowed numbers read as a
 * guess; an owner prior is capped at "fairly sure" — knowledge, never certainty.
 */
export type DemandOverride = {
  forecast30d: number;
  source: "borrowed" | "owner_prior";
  /** Short chip text, e.g. "Borrowed from Cantu Shea Butter" or "Owner expects ~40/mo". */
  label: string;
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
  /**
   * First day the tenant has inventory snapshots for. Bounds how far back
   * `stockoutDates` can be believed: windows reaching past it fall back to
   * gap inference for the uncovered stretch. Absent -> no snapshot truth at all.
   */
  snapshotsSince?: Date;
  /**
   * Day-keys (UTC midnight) to censor from the run rate for reasons OTHER than
   * proven stockouts: past/ongoing promo-window days (whose spike must not
   * inflate the baseline) and days the shop was fully closed (whose zero sales
   * must not deflate it). Dropped from both numerator and denominator, distinct
   * from stockoutDates. Absent/empty -> no change.
   */
  excludedDates?: Date[];
  /**
   * What the owner says each month runs at, 1 = normal (`MonthlyContext`).
   * Blended over the horizon by the days it spends in each month, so a 30-day
   * horizon straddling December and January is neither month twice. Absent or
   * all-normal -> the forecast is untouched.
   */
  monthlyExpectations?: MonthlyExpectation[];
  /** Per-class z overrides for safety stock (tenant setting). Absent -> defaults. */
  serviceZ?: Partial<Record<"A" | "B" | "C", number | null>>;
  /** Cap multiple over the best trailing month (tenant setting). Absent -> 3. */
  capMultiple?: number;
  /** Cold-start borrow / owner expectation that replaces the run rate. Absent ->
   *  forecast from the product's own sales as usual. */
  demandOverride?: DemandOverride | null;
  /** Which demand method to run — the champion for this product's class. */
  demandMethod?: DemandMethod;
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
  /** The honesty word for this number, and the raw signals it came from. */
  confidenceWord: ConfidenceWord;
  confidenceSignals: ConfidenceSignals;
};

/** Days of history available as of `today` (0 when there is none). */
export function historySpanDays(history: SalesPoint[], today: Date): number {
  if (history.length === 0) return 0;
  let earliest = history[0]!.date;
  for (const p of history) if (p.date < earliest) earliest = p.date;
  return (+today - +earliest) / 864e5;
}

/** Spike-damped daily rate over the trailing `windowDays` before `today`.
 *  Censored (proven out-of-stock) days come out of the denominator, and the
 *  floor adapts to signal quality (effectiveWindowDays). */
function rateOverWindow(
  history: SalesPoint[],
  today: Date,
  windowDays: number,
  stockoutDates?: Date[],
  excludedDates?: Date[]
): number {
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - windowDays);
  const excluded = excludedDates?.length ? new Set(excludedDates.map(dayKeyOf)) : null;
  const { units, saleDays } = dampedWindow(history, since, today, excluded);
  const hasMask = !!(stockoutDates?.length || excludedDates?.length);
  const blocked = hasMask ? blockedDaysInWindow(stockoutDates ?? [], excludedDates, since, today) : 0;
  const signal = hasMask ? { inStockDays: windowDays - blocked, saleDays } : undefined;
  return units / effectiveWindowDays(windowDays, blocked, signal);
}

/**
 * The production demand rate (units/day):
 *   <60 days of history -> spike-damped rate over the product's own short window
 *   otherwise           -> recency-weighted, spike-damped 30/90/365-day blend
 * For a new product the window is clamped to the observed history span
 * (floored at 7 days) — dividing a 10-day-old product's sales by a fixed 30
 * would silently under-forecast it 3x. Snapshot-proven stockout days are excluded
 * from denominators when the mask is provided; `snapshotsSince` says how far back
 * that proof reaches, so older history keeps the gap-inference fallback. Passing
 * `snapshotsSince` with an EMPTY mask is meaningful: it means the snapshots prove
 * this product was never out, so nothing is inferred. `excludedDates` (past
 * promo-spike ∪ shop-closure day-keys) are censored from every path — distinct
 * from stockoutDates, so they never flip the censored-vs-inference dispatch.
 */
/** Demand methods the audition can choose between. `run_rate` is the recency-
 *  weighted rate with the full censoring story; `recent_heavy` answers the same
 *  question over a flat trailing month, for a shop whose demand turns quickly. */
export type DemandMethod = "run_rate" | "recent_heavy";
export const CHAMPION_DEFAULT: DemandMethod = "run_rate";

/** Trailing days `recent_heavy` averages over. */
const RECENT_HEAVY_WINDOW_DAYS = 30;

/**
 * The daily demand rate a method reports.
 *
 * Both methods run through the same censoring: a stockout day and a past promo
 * spike are excluded either way. They differ only in how they weight recency,
 * which is the thing the audition is meant to be comparing. A challenger that
 * also quietly dropped stockout correction would win classes by under-counting
 * the days a shelf was empty.
 */
export function demandRateFor(
  method: DemandMethod,
  history: SalesPoint[],
  today: Date,
  opts?: { stockoutDates?: Date[]; excludedDates?: Date[]; snapshotsSince?: Date }
): number {
  if (method === "recent_heavy") {
    return rateOverWindow(
      history,
      today,
      RECENT_HEAVY_WINDOW_DAYS,
      opts?.stockoutDates,
      opts?.excludedDates
    );
  }
  return runRateDaily(
    history,
    today,
    opts?.stockoutDates,
    opts?.excludedDates,
    opts?.snapshotsSince
  );
}

export function runRateDaily(
  history: SalesPoint[],
  today: Date,
  stockoutDates?: Date[],
  excludedDates?: Date[],
  snapshotsSince?: Date
): number {
  const span = historySpanDays(history, today);
  if (span < NEW_PRODUCT_DAYS) {
    const window = Math.min(30, Math.max(7, Math.ceil(span)));
    return rateOverWindow(history, today, window, stockoutDates, excludedDates);
  }
  return stockoutDates?.length || snapshotsSince
    ? weightedDailyRateCensored(history, stockoutDates ?? [], today, excludedDates, snapshotsSince)
    : weightedDailyRateAdjusted(history, today, excludedDates); // gap inference when no snapshot mask
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

  const override = input.demandOverride ?? null;

  // ── Layer 1: recency-weighted run rate (or an external demand override) ────
  const historyDailyRate = demandRateFor(
    input.demandMethod ?? CHAMPION_DEFAULT,
    input.history,
    today,
    {
      stockoutDates: input.stockoutDates,
      excludedDates: input.excludedDates,
      snapshotsSince: input.snapshotsSince,
    }
  );
  // The rate the inventory + sizing math runs on: the override when present
  // (cold-start borrow / owner expectation), else the history run rate.
  const dailyRate = override ? override.forecast30d / 30 : historyDailyRate;
  const layer1 = override ? override.forecast30d : historyDailyRate * 30;

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

  // Promo lift and the runaway cap apply to a history-derived number only. An
  // override IS the stated demand — layering promo/cap on top would double-count
  // or clip the owner's own figure.
  const promo = activePromoLift(input.activePromos, input.productType, input.vendor, input.sku);
  const promoApplies = !override && promo.lift > 1.01;
  if (promoApplies) {
    signals.push({
      label: `Active promo ${promo.channel ?? ""} +${((promo.lift - 1) * 100).toFixed(0)}%`,
      deltaPct: (promo.lift - 1) * 100,
      emoji: "🏷️",
    });
    boosted = boosted * promo.lift;
  }

  // Stated seasonality, on the same terms as a promo: the owner's knowledge
  // rather than the calendar's guess, applied to a history-derived number only,
  // and still bounded by the cap below. An override IS the stated demand, so
  // layering a month multiplier on top would double-count the owner's own
  // figure — the same reason promo is skipped there.
  const seasonal = blendedSeasonalMultiplier(input.monthlyExpectations ?? [], today);
  const seasonLabel = override ? null : seasonalLabel(seasonal);
  // What the season is actually worth here, so the inventory math below uses the
  // same figure the forecast did rather than re-deriving it.
  const seasonalApplied = seasonLabel ? seasonal : 1;
  if (seasonLabel) {
    signals.push({
      label: seasonLabel,
      deltaPct: (seasonal - 1) * 100,
      emoji: "📅",
    });
    boosted = boosted * seasonal;
  }

  // ── Safety cap: never exceed capMultiple x the best trailing month ────────
  const capMultiple = input.capMultiple ?? DEFAULT_CAP_MULTIPLE;
  const best = bestTrailingMonth(input.history, today);
  const cap = best > 0 && !override ? capMultiple * best : Infinity;
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
  // A stated season moves the shelf, not just the order. In a month the shop
  // says runs at 3x, stock drains three times as fast, so cover, the reorder
  // point and urgency all have to move with it — otherwise the buy list sizes
  // for the season while the trigger that fires it still waits for a normal
  // month, and the shop stocks out in the month it warned us about.
  //
  // Net of the cap: sizing the shelf on a lift the order quantity was not
  // allowed to keep would hold the two to different numbers. A month at or
  // below normal is never clipped — the cap only ever bounds a lift.
  const clipRatio = boosted > 0 ? capped / boosted : 1;
  const effectiveSeasonal =
    seasonalApplied >= 1 ? Math.max(1, seasonalApplied * clipRatio) : seasonalApplied;
  const sizingDailyRate = dailyRate * effectiveSeasonal;

  const demandStd = standardDeviation(last90Pts.map((p) => p.quantity));
  const z = zForServiceLevel(input.abcCategory, input.serviceZ);
  const safety = kingsSafetyStock({
    z,
    leadTimeAvg: input.leadTimeAvg,
    leadTimeStd: input.leadTimeStd,
    demandAvg: sizingDailyRate,
    demandStd,
  });
  const rop = reorderPoint(sizingDailyRate, input.leadTimeAvg, safety);
  const daysLeft = daysOfStockRemaining(input.currentStock, sizingDailyRate);

  // A product with sales history but no run rate is a dead listing: never
  // recommended, never counted as a stockout, even at zero stock. A product
  // with NO history at all is not dead — it's too new to judge. An override
  // (borrow / owner prior) supplies a real demand, so neither state applies.
  const isDead = hasHistory && historyDailyRate <= 0 && !override;
  const tooNew = !hasHistory && !override;
  if (override?.source === "borrowed") {
    signals.push({ label: override.label, deltaPct: 0, emoji: "🔗" });
  } else if (override?.source === "owner_prior") {
    signals.push({ label: override.label, deltaPct: 0, emoji: "🗣️" });
  }
  if (tooNew) {
    signals.push({ label: "New product — no sales history yet", deltaPct: 0, emoji: "🆕" });
  } else if (isNew && hasHistory && !override) {
    signals.push({
      label: `New product — forecast from ${Math.max(1, Math.round(span))} days of history`,
      deltaPct: 0,
      emoji: "🆕",
    });
  }
  const urgency: Urgency = isDead || tooNew ? "low" : urgencyFromDays(daysLeft, sizingDailyRate);
  const recommendedQty =
    isDead || tooNew ? 0 : Math.max(0, Math.ceil(finalForecast30d + safety - input.currentStock));

  // ── Confidence word: the honesty label that travels with the number ───────
  const stockoutGapDays = input.stockoutDates?.length
    ? censoredDaysInWindow(input.stockoutDates, last30, today)
    : inferredStockoutGapDays(input.history, last30, today);
  const confidenceSignals: ConfidenceSignals = {
    historyDays: span,
    cv,
    stockoutGapShare: Math.max(0, Math.min(1, stockoutGapDays / 30)),
    promoContaminated: promoApplies,
    coldStart: tooNew || override?.source === "borrowed",
  };
  let word = confidenceWord(confidenceSignals);
  // An owner expectation is knowledge, not history — it never reads as "sure".
  if (override?.source === "owner_prior") word = leastConfident(word, "fairly_sure");

  // The prose is read beside LIVE figures — the product page prints it under a
  // run rate and a cover recomputed at request time. So it states the run's
  // decision and never a units/day rate of its own (that question has one answer
  // on screen, the live one), and the stock it did decide against is stamped as
  // of the run rather than written in the present tense.
  /**
   * How the sentence describes the delivery wait.
   *
   * `leadTimeAvg` is 0 when there is no lead data — deliberate, so an order is
   * never inflated on a guess (see the field's contract above). Printing it
   * as "lead time 0±7d" told the shop their supplier delivers in no days and
   * left them no idea why the number looked like that; on a workspace whose one
   * supplier has no lead time, that was every product on every screen.
   */
  const leadClause =
    input.leadTimeAvg > 0
      ? `lead time ${input.leadTimeAvg}±${input.leadTimeStd}d`
      : "no delivery time set for this supplier — sized for the review cycle only";

  const stockAtRun =
    daysLeft >= NO_STOCKOUT_DAYS
      ? `Stock at the run was ${input.currentStock}, with no stockout in sight.`
      : `Stock at the run was ${input.currentStock} — about ${daysLeft} days' cover then.`;

  const reasoning = (tooNew
    ? [
        "No sales history yet — too new to forecast; collect sales before ordering against a prediction.",
        `Stock at the run was ${input.currentStock}.`,
      ]
    : override?.source === "borrowed"
      ? [
          `Too new to forecast from its own sales — borrowing an established similar product's shape (${override.label}): ${finalForecast30d.toFixed(0)} units over 30 days. Real sales take over as history builds.`,
          `Safety stock ${safety.toFixed(0)} (${input.abcCategory ?? "C"}-class service, z=${z}, ${leadClause}).`,
          stockAtRun,
        ]
      : override?.source === "owner_prior"
        ? [
            `Using the owner's expectation (${override.label}): ${finalForecast30d.toFixed(0)} units over 30 days.`,
            `Safety stock ${safety.toFixed(0)} (${input.abcCategory ?? "C"}-class service, z=${z}, ${leadClause}); reorder point ${rop.toFixed(0)}.`,
            stockAtRun,
          ]
        : [
            `Forecast ${finalForecast30d.toFixed(0)} units over 30 days from the ${
              isNew ? `last-${Math.max(1, Math.round(span))}-day rate (new product)` : "recency-weighted run rate (30/90/365-day blend)"
            }.`,
            wasCapped ? `Capped at ${capMultiple}× the best month (${best.toFixed(0)}) to block runaway numbers.` : "",
            `Safety stock ${safety.toFixed(0)} (${input.abcCategory ?? "C"}-class service, z=${z}, ${leadClause}); reorder point ${rop.toFixed(0)}.`,
            stockAtRun,
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
    confidenceWord: word,
    confidenceSignals,
  };
}
