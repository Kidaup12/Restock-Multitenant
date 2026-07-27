/**
 * Spike detection — "was this a promo?" suggestions.
 *
 * An un-logged demand spike (an influencer post, a bulk buyer, a flash sale
 * nobody recorded) bleeds into the baseline run rate and quietly inflates
 * future orders. The guardrail caps the worst of it, but the RIGHT fix is to
 * label the spike as a promo so its days are excluded from the baseline
 * (promo-windows.ts). This module finds those spikes so the app can PROMPT the
 * owner to log them, instead of relying on memory.
 *
 * Callers pass sales history + existing promo windows; this returns the spike
 * days that aren't already covered by a promo.
 */
import { median, type SalesPoint } from "./baseline";

export type SpikePromoWindow = { start: Date; end: Date };

export type Spike = {
  date: Date;
  quantity: number;
  /** The item's baseline units/day the spike is measured against. */
  baseline: number;
  /** quantity / baseline — how many times normal this day sold. */
  multiple: number;
};

/** A day is a spike when it sold at least this many times the baseline rate. */
export const SPIKE_MULTIPLE = 3;
/** …and at least this many units (so a jump from 0.2 to 1 isn't a "spike"). */
const SPIKE_MIN_UNITS = 8;
/** Baseline = median of the trailing window's non-zero sale days (robust to the
 *  spike itself and to empty-shelf zeros). */
const BASELINE_WINDOW_DAYS = 60;

/**
 * Find spike days in the recent history that are NOT already inside a logged
 * promo window. `lookbackDays` bounds how far back to surface suggestions
 * (recent spikes are the actionable ones — an old spike is water under the
 * bridge).
 */
export function detectSpikes(
  history: SalesPoint[],
  promoWindows: SpikePromoWindow[],
  asOf: Date,
  lookbackDays = 14
): Spike[] {
  if (history.length === 0) return [];

  const baselineSince = new Date(asOf.getTime() - BASELINE_WINDOW_DAYS * 86_400_000);
  const nonZero = history
    .filter((h) => h.date >= baselineSince && h.date <= asOf && h.quantity > 0)
    .map((h) => h.quantity);
  const baseline = median(nonZero);
  if (baseline <= 0) return [];

  const recentSince = new Date(asOf.getTime() - lookbackDays * 86_400_000);
  const inPromo = (d: Date) => promoWindows.some((w) => d >= w.start && d <= w.end);

  const spikes: Spike[] = [];
  for (const h of history) {
    if (h.date < recentSince || h.date > asOf) continue;
    if (h.quantity < SPIKE_MIN_UNITS) continue;
    if (h.quantity < baseline * SPIKE_MULTIPLE) continue;
    if (inPromo(h.date)) continue; // already explained — don't nag
    spikes.push({
      date: h.date,
      quantity: h.quantity,
      baseline,
      multiple: Math.round((h.quantity / baseline) * 10) / 10,
    });
  }
  // Biggest surprises first.
  return spikes.sort((a, b) => b.multiple - a.multiple);
}
