/**
 * Calibrated demand-cover quantile for newsvendor ordering.
 *
 * Ordering to a service-level QUANTILE only works if that quantile is well
 * CALIBRATED — a raw empirical quantile collapses on sparse/lumpy SKUs, and the
 * textbook NORMAL safety-stock formula mis-sizes the skewed, over-dispersed
 * demand that dominates intermittent retail. This module computes the quantile
 * of a moment-matched count distribution instead:
 *   - Negative-Binomial when demand is over-dispersed (variance > mean) — the
 *     usual case; it has the right fat right tail.
 *   - Poisson when it isn't.
 * Parametric, so it stays sensible even when a SKU has few non-zero days, and
 * skewed, so it covers better per unit of stock than Normal.
 */

const EPS = 1e-9;

/**
 * Inverse CDF (quantile) of an over-dispersed count distribution with the given
 * mean and variance, by moment-matching to Negative-Binomial (Poisson when not
 * over-dispersed). Returns the smallest integer q with CDF(q) >= tau — i.e. the
 * units that cover demand with probability `tau`.
 */
export function countQuantile(mean: number, variance: number, tau: number): number {
  if (mean <= EPS || tau <= 0) return 0;
  if (tau >= 1) tau = 0.999999;
  const v = Math.max(variance, mean); // never tighter than Poisson
  const cap = Math.ceil(mean + 50 * Math.sqrt(v) + 100); // loop backstop

  // Poisson branch (not over-dispersed).
  if (v <= mean * (1 + 1e-6)) {
    let pmf = Math.exp(-mean);
    let cum = pmf;
    if (cum >= tau) return 0;
    for (let k = 1; k <= cap; k++) {
      pmf *= mean / k;
      cum += pmf;
      if (cum >= tau) return k;
    }
    return cap;
  }

  // Negative-Binomial: size r = μ²/(σ²−μ), success prob = r/(r+μ).
  const r = (mean * mean) / (v - mean);
  const prob = r / (r + mean);
  let pmf = Math.pow(prob, r); // P(X=0)
  let cum = pmf;
  if (cum >= tau) return 0;
  for (let k = 1; k <= cap; k++) {
    pmf *= ((k - 1 + r) / k) * (1 - prob);
    cum += pmf;
    if (cum >= tau) return k;
  }
  return cap;
}

export type CalibratedCoverInput = {
  /** Expected daily demand (bias-correct it upstream if the forecast runs light). */
  dailyMean: number;
  /** Variance of daily demand (e.g. sample variance of the recent daily series). */
  dailyVar: number;
  /** Protection interval in days — lead time + review period. */
  horizonDays: number;
  /** Target cycle service level (e.g. 0.95). */
  tau: number;
  /** Minimum index of dispersion (var/mean). Floors a thin variance estimate so a
   *  sparse SKU still gets a realistic fat tail instead of a too-tight cover. */
  dispersionFloor?: number;
  /** Multiplicative correction for a known forecast bias (>1 lifts a light forecast). */
  biasFactor?: number;
};

/**
 * Order-up-to cover: the tau-quantile of total demand over the protection interval.
 * Scales daily mean/variance to the horizon (iid approximation), floors the
 * dispersion, then inverts the count distribution.
 */
export function calibratedCover(opts: CalibratedCoverInput): number {
  const bias = opts.biasFactor ?? 1;
  const h = Math.max(1, opts.horizonDays);
  const dailyMean = Math.max(0, opts.dailyMean * bias);
  if (dailyMean <= EPS) return 0;
  const idFloor = opts.dispersionFloor ?? 1.5;
  const dailyVar = Math.max(opts.dailyVar, dailyMean * idFloor);
  return countQuantile(dailyMean * h, dailyVar * h, opts.tau);
}
