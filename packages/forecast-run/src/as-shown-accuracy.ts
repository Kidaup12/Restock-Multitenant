import { prismaForTenant } from "@wezesha/db";

/**
 * Scores what the shop was actually TOLD against what it actually sold.
 *
 * The walk-forward backtest answers a different question. It replays the forecast
 * over the shop's own history using TODAY's engine, so it reports what the engine
 * would say now about back then — a fair measure of the engine, and no measure at
 * all of the advice the shop acted on. Change the engine and the whole trail moves
 * underneath you, including the parts describing months already sold.
 *
 * ForecastRecommendation is the other half: an append-only record of the number
 * put in front of the shop on the day, kept for the retention window. Scoring it
 * against SalesHistory is the only way to answer "was what we told you right?",
 * and it is the only measure that survives an engine change.
 *
 * Written as BacktestRun rows under a distinct tag so the two trails sit side by
 * side and are never averaged together.
 */

const DAY_MS = 86_400_000;

/** Tag distinguishing these rows from the re-derived `walkforward` trail. */
export const AS_SHOWN_TAG = "as_shown";

/** The horizon the stored number described: finalForecast30d is 30 days. */
export const AS_SHOWN_HORIZON_DAYS = 30;

/** A run is only scorable once its whole horizon has elapsed. */
export type AsShownAccuracyOutcome = {
  /** Distinct run days scored by this call. */
  runsScored: number;
  /** BacktestRun rows written (one per class plus ALL, per scored run day). */
  rowsWritten: number;
};

type Scored = {
  abcClass: string;
  said: number;
  happened: number;
  sampleSize: number;
  absError: number;
  pctErrorSum: number;
  pctErrorCount: number;
};

/** Plain lean word, on the same 5% dead band the walk-forward trail uses. */
export function leansOf(said: number, happened: number): "over" | "under" | "even" {
  if (happened <= 0) return said > 0 ? "over" : "even";
  const delta = (said - happened) / happened;
  if (delta > 0.05) return "over";
  if (delta < -0.05) return "under";
  return "even";
}

function blank(abcClass: string): Scored {
  return {
    abcClass,
    said: 0,
    happened: 0,
    sampleSize: 0,
    absError: 0,
    pctErrorSum: 0,
    pctErrorCount: 0,
  };
}

/**
 * Score every stored recommendation whose 30-day horizon has fully elapsed and
 * which has not been scored already, and persist the rollup.
 *
 * Idempotent by run day: a day already carrying `as_shown` rows is skipped, so
 * re-running never double-counts or drifts.
 */
export async function recordAsShownAccuracy(
  tenantId: string,
  now: Date = new Date()
): Promise<AsShownAccuracyOutcome> {
  const db = prismaForTenant(tenantId);

  // Only fully-elapsed horizons are scorable: a run from ten days ago has twenty
  // days of sales still to come, and scoring it now would report a shortfall that
  // has not happened yet.
  const scorableBefore = new Date(now.getTime() - AS_SHOWN_HORIZON_DAYS * DAY_MS);

  const [recommendations, alreadyScored] = await Promise.all([
    db.forecastRecommendation.findMany({
      where: { runDate: { lte: scorableBefore } },
      select: {
        productId: true,
        runDate: true,
        finalForecast30d: true,
        abcClass: true,
      },
      orderBy: { runDate: "asc" },
    }),
    db.backtestRun.findMany({
      where: { tag: AS_SHOWN_TAG },
      select: { runDate: true },
    }),
  ]);
  if (recommendations.length === 0) return { runsScored: 0, rowsWritten: 0 };

  const scoredDays = new Set(alreadyScored.map((r) => r.runDate.getTime()));
  const pending = recommendations.filter((r) => !scoredDays.has(r.runDate.getTime()));
  if (pending.length === 0) return { runsScored: 0, rowsWritten: 0 };

  // One sales read spanning every pending window, then bucketed in memory. The
  // alternative is a query per product per run day, which on a year of retention
  // is thousands of round trips.
  let earliest = pending[0]!.runDate;
  for (const r of pending) if (r.runDate < earliest) earliest = r.runDate;
  const latestEnd = new Date(
    Math.max(...pending.map((r) => r.runDate.getTime())) + AS_SHOWN_HORIZON_DAYS * DAY_MS
  );

  const sales = await db.salesHistory.findMany({
    where: { date: { gte: earliest, lt: latestEnd } },
    select: { productId: true, date: true, quantity: true },
  });

  const salesByProduct = new Map<string, { at: number; qty: number }[]>();
  for (const s of sales) {
    const list = salesByProduct.get(s.productId);
    const point = { at: s.date.getTime(), qty: s.quantity };
    if (list) list.push(point);
    else salesByProduct.set(s.productId, [point]);
  }

  // Group by run day, then by class within it, plus an ALL rollup per day.
  const byDay = new Map<number, Map<string, Scored>>();
  for (const rec of pending) {
    const start = rec.runDate.getTime();
    const end = start + AS_SHOWN_HORIZON_DAYS * DAY_MS;
    let happened = 0;
    for (const s of salesByProduct.get(rec.productId) ?? []) {
      if (s.at >= start && s.at < end) happened += s.qty;
    }
    const said = rec.finalForecast30d;

    let classes = byDay.get(start);
    if (!classes) {
      classes = new Map();
      byDay.set(start, classes);
    }
    // Every product lands in the ALL rollup and, when it held a class that day,
    // in that class too. A product with no class is still part of the shop.
    const buckets = ["ALL"];
    if (rec.abcClass === "A" || rec.abcClass === "B" || rec.abcClass === "C") {
      buckets.push(rec.abcClass);
    }
    for (const key of buckets) {
      const bucket = classes.get(key) ?? blank(key);
      bucket.said += said;
      bucket.happened += happened;
      bucket.sampleSize += 1;
      bucket.absError += Math.abs(said - happened);
      // MAPE is undefined against a zero actual; those products still count in
      // units, they just cannot carry a percentage.
      if (happened > 0) {
        bucket.pctErrorSum += Math.abs(said - happened) / happened;
        bucket.pctErrorCount += 1;
      }
      classes.set(key, bucket);
    }
  }

  const rows = [];
  for (const [dayMs, classes] of byDay) {
    for (const bucket of classes.values()) {
      if (bucket.sampleSize === 0) continue;
      rows.push({
        tenantId,
        runDate: new Date(dayMs),
        mae: bucket.absError / bucket.sampleSize,
        bias:
          bucket.happened > 0 ? (bucket.said - bucket.happened) / bucket.happened : 0,
        mape:
          bucket.pctErrorCount > 0 ? bucket.pctErrorSum / bucket.pctErrorCount : null,
        sampleSize: bucket.sampleSize,
        tag: AS_SHOWN_TAG,
        abcClass: bucket.abcClass,
        // The as-shown trail scores the advice, not a model. Pinning the method
        // the scorecard reads keeps one row per day answerable by the same query
        // shape as the walk-forward trail.
        method: "run_rate",
        saidUnits: bucket.said,
        happenedUnits: bucket.happened,
        leans: leansOf(bucket.said, bucket.happened),
      });
    }
  }
  if (rows.length === 0) return { runsScored: 0, rowsWritten: 0 };

  await db.backtestRun.createMany({ data: rows });
  return { runsScored: byDay.size, rowsWritten: rows.length };
}
