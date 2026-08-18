/**
 * Scale-free accuracy, for judging one forecasting method against another.
 *
 * Mean absolute error alone cannot do that job on a shop's long tail. MAE is
 * minimised by the conditional MEDIAN, and on an intermittent product — sells
 * nothing most weeks, a handful occasionally — the median is zero. A method
 * that gives up and forecasts nothing therefore scores BETTER on MAE than one
 * that correctly anticipates the occasional sale, and it wins by a margin wide
 * enough to clear any sane challenger threshold.
 *
 * Two metrics here fix that, and one deliberately does not:
 *
 *   `rmsse` is minimised by the conditional MEAN, so a giving-up method is
 *     penalised for the spikes it misses. This is the one selection should use.
 *   `pinball` at a high service quantile prices under-forecasting far above
 *     over-forecasting, which is the shop's real asymmetry: a stockout costs a
 *     sale, an over-buy costs shelf space.
 *   `mase` does NOT catch a giving-up method. Its denominator comes from the
 *     history alone, so it is MAE divided by a per-product constant — a rescale,
 *     which cannot reorder two methods on the same product. It earns its place
 *     for a different job: comparing or pooling ACROSS products of different
 *     sizes, and tracking one shop over time as its volume grows.
 */

/** Below this a scale is treated as zero — the series is flat and cannot
 *  normalise anything. */
const EPS = 1e-9;

/** Weekly cadence: retail demand repeats by day-of-week far more than day-to-day. */
export const SEASON_DAYS = 7;

/**
 * Mean absolute change at lag `m` across the history — how hard this product is
 * to predict at all. Null when the series is too short to difference, or so
 * flat that the scale would be zero.
 */
export function naiveMaeScale(daily: number[], m = 1): number | null {
  if (daily.length < m + 1) return null;
  let sum = 0;
  for (let i = m; i < daily.length; i++) sum += Math.abs(daily[i]! - daily[i - m]!);
  const scale = sum / (daily.length - m);
  return scale > EPS ? scale : null;
}

/** The squared counterpart of `naiveMaeScale`, for RMSSE. */
export function naiveMseScale(daily: number[], m = 1): number | null {
  if (daily.length < m + 1) return null;
  let sum = 0;
  for (let i = m; i < daily.length; i++) {
    const d = daily[i]! - daily[i - m]!;
    sum += d * d;
  }
  const scale = sum / (daily.length - m);
  return scale > EPS ? scale : null;
}

/**
 * Asymmetric loss for a quantile forecast: under-forecasting by one unit costs
 * `tau`, over-forecasting costs `1 - tau`. At tau 0.95 a shortfall hurts 19×
 * more than an equal excess, which is the trade a shop actually makes.
 */
export function pinballLoss(actual: number, predicted: number, tau: number): number {
  const d = actual - predicted;
  return d >= 0 ? tau * d : (tau - 1) * d;
}

/** Seasonal scale where the history allows it, otherwise the day-to-day one —
 *  a perfectly weekly series has no lag-7 movement to normalise against. */
function scaleWithFallback(
  daily: number[],
  at: (d: number[], m: number) => number | null
): number | null {
  return at(daily, SEASON_DAYS) ?? at(daily, 1);
}

export type WindowError = {
  /** What the method forecast for the window. */
  said: number;
  /** What the product actually sold in it. */
  happened: number;
};

export type ScaleFreeAccuracy = {
  /** MAE over the naive seasonal error — comparable across products, but NOT a
   *  defence against a method that forecasts nothing. */
  mase: number | null;
  /** Root mean squared scaled error. Minimised by the mean, so a giving-up
   *  method loses here. This is what a champion should be chosen on. */
  rmsse: number | null;
  /** Mean pinball loss at `tau`, in units. Null when nothing was scored. */
  pinball: number | null;
};

/**
 * Score a method's windows against the product's own history.
 *
 * `daily` is the daily series the scales are derived from — the history the
 * method had to learn from, not the windows it is being judged on.
 */
export function scaleFreeAccuracy(
  windows: readonly WindowError[],
  daily: number[],
  tau: number
): ScaleFreeAccuracy {
  if (windows.length === 0) return { mase: null, rmsse: null, pinball: null };

  let absErr = 0;
  let sqErr = 0;
  let pinball = 0;
  for (const w of windows) {
    const err = w.said - w.happened;
    absErr += Math.abs(err);
    sqErr += err * err;
    pinball += pinballLoss(w.happened, w.said, tau);
  }
  const n = windows.length;

  const maeScale = scaleWithFallback(daily, naiveMaeScale);
  const mseScale = scaleWithFallback(daily, naiveMseScale);

  return {
    mase: maeScale != null ? absErr / n / maeScale : null,
    rmsse: mseScale != null ? Math.sqrt(sqErr / n / mseScale) : null,
    pinball: pinball / n,
  };
}
