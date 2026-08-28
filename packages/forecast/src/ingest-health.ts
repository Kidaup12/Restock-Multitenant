/**
 * Ingest-health gate — the "no data ≠ no demand" safety stop.
 *
 * A silent broken feed and a genuine zero look IDENTICAL in the numbers but mean
 * the opposite. If the forecast runs off a hole, the app confidently tells the
 * shop to order nothing for a month. So BEFORE re-forecasting a tenant we sanity-
 * check the most recent ingest against the shop's OWN recent norm:
 *
 *   - STALE : the newest sale is older than `maxStaleHours` → the feed stopped.
 *   - GAP   : one or more of the most-recent completed days came in far below the
 *             shop's trailing norm → likely feed-gap days, not zero demand.
 *
 * On STALE (or too many gap days) we DON'T re-forecast — the caller keeps the
 * last-good predictions and alerts the owner. A short recoverable gap (≤
 * `maxImputeDays`) is IMPUTED: the gap day-keys are handed back so the caller can
 * censor them from the run-rate denominator (the same mechanism as proven
 * stockout days), and the forecast runs normally. We never invent sales.
 *
 * Pure: no I/O. The caller passes the daily series (excluding today, which is
 * partial) and the newest sale timestamp.
 */

/** Per-day ingested units. `day` is a UTC-midnight epoch (ms) key. */
export type DailyPoint = { dayKey: number; units: number };

export type IngestHealthConfig = {
  /** Feed considered stopped past this many hours with no new sale. */
  maxStaleHours: number;
  /** A day below this fraction of the trailing norm is a feed-gap day. */
  lowFrac: number;
  /** Don't second-guess a genuinely slow tiny shop: skip the gap check when the
   *  trailing norm is below this many units/day. */
  minNorm: number;
  /** How many most-recent completed days to scan for gaps. */
  imputeLookback: number;
  /** ≤ this many gap days → IMPUTE and forecast; more → HARD STOP. */
  maxImputeDays: number;
};

export const DEFAULT_INGEST_HEALTH: IngestHealthConfig = {
  maxStaleHours: 36,
  lowFrac: 0.2,
  minNorm: 10,
  imputeLookback: 7,
  maxImputeDays: 2,
};

export type IngestVerdict = {
  /** True = safe to write a fresh forecast. False = keep the last-good one. */
  ok: boolean;
  /** True = skip the run entirely (feed stale, or too many gap days to patch). */
  stop: boolean;
  /** True = a short recoverable gap: censor `gapDayKeys` and forecast normally. */
  impute: boolean;
  /** UTC-midnight day-keys to exclude from the run-rate denominator. */
  gapDayKeys: number[];
  /** Human-readable, for the owner alert. */
  reasons: string[];
  stale: boolean;
  trailingNorm: number;
};

/** Value at quantile `f` (0..1) of the set; 0 when empty. */
function quantile(xs: number[], f: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * f))]!;
}

/**
 * @param daily         per-day ingested units, ascending by dayKey, EXCLUDING
 *                       today (today is partial — judge the last COMPLETED day).
 * @param latestSaleAt  timestamp of the newest sale row (any channel).
 * @param now           current time.
 */
export function assessIngestHealth(
  daily: DailyPoint[],
  latestSaleAt: Date | null,
  now: Date,
  cfg: IngestHealthConfig = DEFAULT_INGEST_HEALTH
): IngestVerdict {
  const reasons: string[] = [];

  // Staleness — the feed stopped delivering entirely.
  const staleHours =
    latestSaleAt == null ? Infinity : (now.getTime() - latestSaleAt.getTime()) / 3_600_000;
  const stale = staleHours > cfg.maxStaleHours;
  if (stale) {
    reasons.push(
      latestSaleAt == null
        ? "No sales data at all — the feed may never have connected."
        : `No new sales for about ${Math.round(staleHours)}h — the feed looks stopped.`
    );
  }

  // The "normal day" reference must resist a CLUSTER of recent gap days: if the
  // feed has been down several days, plain-median would sink with them and hide
  // the outage from itself. The upper-half (p75) of the window stays anchored to
  // genuine trading days — a handful of broken days can't pull it down.
  const prior = daily.slice(0, -1).map((d) => d.units);
  const norm = quantile(prior.length ? prior : daily.map((d) => d.units), 0.75);
  const lowThreshold = cfg.lowFrac * norm;

  // Feed-gap days — recent completed days whose units are far below the norm.
  // Only when the norm is meaningful, so a slow tiny shop isn't second-guessed.
  const gapDayKeys: number[] = [];
  if (norm >= cfg.minNorm) {
    for (const d of daily.slice(-cfg.imputeLookback)) {
      if (d.units < lowThreshold) gapDayKeys.push(d.dayKey);
    }
  }

  // Decide: IMPUTE a short recoverable gap, or HARD-STOP a real outage.
  let impute = false;
  let stop = stale;
  if (!stale && gapDayKeys.length > cfg.maxImputeDays) {
    stop = true;
    reasons.push(
      `${gapDayKeys.length} of the last ${cfg.imputeLookback} days came in far below normal ` +
        `(under ${Math.round(lowThreshold)} vs the usual ~${Math.round(norm)}/day) — too many ` +
        `to safely patch. Forecast paused; the feed likely broke.`
    );
  } else if (!stale && gapDayKeys.length > 0) {
    impute = true;
    reasons.push(
      `Ignored ${gapDayKeys.length} feed-gap day(s) that came in under ${Math.round(
        cfg.lowFrac * 100
      )}% of the usual ~${Math.round(norm)}/day — excluded from the rate, not counted as zero demand.`
    );
  }

  return { ok: !stop, stop, impute, gapDayKeys, reasons, stale, trailingNorm: norm };
}
