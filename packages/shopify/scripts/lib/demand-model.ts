/**
 * The demand model behind the seeded store.
 *
 * Pure and deterministic: same SKU and same day always give the same units, with
 * no I/O anywhere. That is what lets the generator run as a dry-run — you can
 * see the shape of a year of trading, and iterate on it, before spending hours
 * pushing orders into Shopify at five a minute.
 *
 * The numbers are chosen to make the forecast's own features *observable*.
 * A flat random walk would produce a catalogue where every product looks the
 * same, and prove nothing:
 *
 *  - ABC classes need sales VALUE spread over orders of magnitude, so base rate
 *    and price both vary widely.
 *  - The run rate blends 30/90/365-day windows, so a trend has to be slow enough
 *    to still be visible at a year.
 *  - Spike damping only engages above a median multiple, and spike *detection*
 *    only looks back a fortnight — so some promos must land inside it.
 *  - Dead stock, cold start and current stockouts are each a distinct shape, not
 *    a low number.
 */

export type Archetype =
  | "hero"
  | "steady"
  | "slow"
  | "dead"
  | "new"
  | "no-history"
  | "riser"
  | "faller"
  | "overstocked";

export type Window = { fromDaysAgo: number; toDaysAgo: number };

export type SeedSku = {
  sku: string;
  title: string;
  archetype: Archetype;
  priceKes: number;
  /** null = deliberately missing, to exercise the unplannable path. */
  costKes: number | null;
  /** Mean units per trading day before any modifier. */
  base: number;
  /** Compounding daily drift; positive rises, negative decays. */
  trendPerDay: number;
  /** Days ago the product started selling. Older than the horizon = always. */
  firstSaleDaysAgo: number;
  /** Days ago it stopped selling; 0 = still selling today. */
  lastSaleDaysAgo: number;
  /** Windows with no stock — sales are zero and the gap is genuine. */
  stockouts: Window[];
  /** Promotion windows, with the multiple applied to that day's demand. */
  promos: Array<Window & { multiple: number }>;
  /** Per-SKU seasonal offset, so the catalogue doesn't peak in unison. */
  seasonPhase: number;
  /** Units left on hand at the end of the run. */
  finalStock: number;
};

const DAY_MS = 86_400_000;

/** Small, fast, and stable across runs — the seed makes the whole store
 *  reproducible, which matters when a throttled run has to be restarted. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Retail week: quiet Monday, busy Friday and Saturday, slow Sunday. */
export function weekdayFactor(date: Date): number {
  return [0.55, 0.8, 0.85, 0.9, 1.0, 1.35, 1.5][date.getUTCDay()]!;
}

/** One gentle yearly cycle plus a December lift — enough that twelve months of
 *  history looks different from twelve copies of one month. */
export function seasonFactor(date: Date, phase: number): number {
  const dayOfYear = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS);
  const cycle = 1 + 0.25 * Math.sin((2 * Math.PI * (dayOfYear - 320 + phase)) / 365);
  const december = date.getUTCMonth() === 11 && date.getUTCDate() <= 24 ? 1.6 : 1;
  return cycle * december;
}

function inWindow(daysAgo: number, w: Window): boolean {
  return daysAgo <= w.fromDaysAgo && daysAgo >= w.toDaysAgo;
}

/** Poisson draw, small-mean exact (Knuth). Demand is counts, not a smooth curve
 *  — a product selling 0.2/day should mostly sell nothing and occasionally two. */
function poisson(mean: number, rnd: () => number): number {
  if (mean <= 0) return 0;
  if (mean > 30) {
    // Normal approximation; exact Knuth would loop ~mean times for no gain.
    const u1 = Math.max(rnd(), 1e-9);
    const u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(mean + z * Math.sqrt(mean)));
  }
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rnd();
  } while (p > limit);
  return k - 1;
}

/** Units sold of one SKU on one day. `daysAgo` 0 is today. */
export function dailyUnits(sku: SeedSku, date: Date, daysAgo: number): number {
  if (daysAgo > sku.firstSaleDaysAgo) return 0; // not launched yet
  if (daysAgo < sku.lastSaleDaysAgo) return 0; // stopped selling
  if (sku.stockouts.some((w) => inWindow(daysAgo, w))) return 0; // no stock to sell

  const promo = sku.promos.find((w) => inWindow(daysAgo, w));
  const age = sku.firstSaleDaysAgo - daysAgo; // days since launch
  const mean =
    sku.base *
    weekdayFactor(date) *
    seasonFactor(date, sku.seasonPhase) *
    Math.exp(sku.trendPerDay * age) *
    (promo ? promo.multiple : 1);

  const rnd = mulberry32(hashString(`${sku.sku}:${daysAgo}`));
  const units = poisson(mean, rnd);
  // A promotion nobody notices is not a promotion: spike DETECTION needs both a
  // multiple of the median and a floor in absolute units.
  return promo && units > 0 ? Math.max(units, 8) : units;
}

/** Total units and revenue over the horizon — the dry-run's raw material. */
export function simulate(
  sku: SeedSku,
  days: number,
  today: Date
): { units: number; revenue: number; sellingDays: number; daysSinceLastSale: number | null } {
  let units = 0;
  let sellingDays = 0;
  let lastSale: number | null = null;
  for (let daysAgo = days; daysAgo >= 0; daysAgo--) {
    const date = new Date(today.getTime() - daysAgo * DAY_MS);
    const sold = dailyUnits(sku, date, daysAgo);
    if (sold > 0) {
      units += sold;
      sellingDays++;
      lastSale = daysAgo;
    }
  }
  return {
    units,
    revenue: units * sku.priceKes,
    sellingDays,
    daysSinceLastSale: lastSale,
  };
}
