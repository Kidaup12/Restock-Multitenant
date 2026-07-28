import { mulberry32, hashString, type Archetype, type SeedSku, type Window } from "./demand-model";

/**
 * The catalogue the generator builds, as data.
 *
 * One row per VARIANT, because that is how the app stores a product — a
 * six-shade foundation is six SKUs. The mix is chosen so that every branch the
 * buy list has to take is represented by something: a missing cost, a cost above
 * the selling price, a product that stopped selling months ago, one that has
 * never sold at all, one out of stock right now.
 *
 * Deterministic from `seed`, so a run interrupted by a rate limit rebuilds the
 * identical catalogue and can be resumed.
 */

/** Multi-variant products, so the per-variant handling is genuinely exercised. */
const SHADES = ["Ivory", "Sand", "Honey", "Amber", "Chestnut", "Espresso"];
const SIZES = ["50ml", "100ml", "250ml", "500ml"];

const FAMILIES = [
  { name: "Argan Oil", type: "OILS", variants: SIZES, price: [900, 2600] },
  { name: "Shea Butter", type: "BODY", variants: SIZES, price: [600, 1800] },
  { name: "Foundation", type: "MAKEUP", variants: SHADES, price: [1200, 3200] },
  { name: "Concealer", type: "MAKEUP", variants: SHADES, price: [800, 2200] },
  { name: "Hair Food", type: "HAIR", variants: SIZES, price: [400, 1200] },
  { name: "Cleanser", type: "SKIN", variants: SIZES, price: [700, 2100] },
  { name: "Body Lotion", type: "BODY", variants: SIZES, price: [500, 1600] },
  { name: "Lip Balm", type: "MAKEUP", variants: ["Clear", "Rose", "Berry"], price: [250, 700] },
  { name: "Face Serum", type: "SKIN", variants: SIZES, price: [1500, 4800] },
  { name: "Braiding Gel", type: "HAIR", variants: SIZES, price: [300, 950] },
];

/**
 * How many of each shape. Counts are deliberate, not proportional to realism:
 * enough dead stock to see the dead-stock tile move, enough cold-start SKUs to
 * exercise the borrow path, but a catalogue still dominated by ordinary slow
 * movers — which is what a real beauty shop looks like.
 */
const MIX: Array<{ archetype: Archetype; count: number }> = [
  { archetype: "hero", count: 20 },
  { archetype: "steady", count: 90 },
  { archetype: "slow", count: 165 },
  { archetype: "dead", count: 25 },
  { archetype: "new", count: 25 },
  { archetype: "no-history", count: 10 },
  { archetype: "riser", count: 20 },
  { archetype: "faller", count: 20 },
  { archetype: "overstocked", count: 25 },
];

export const CATALOGUE_SIZE = MIX.reduce((n, m) => n + m.count, 0); // 400

/**
 * Scales every base rate at once. Set so a 400-SKU catalogue turns over on the
 * order of KES 100k a day across three branches — a believable multi-branch
 * beauty retailer. The forecast's behaviour doesn't depend on the scale, but a
 * demo showing implausible revenue undermines everything it is meant to show.
 */
const RATE_SCALE = 0.2;

function pick<T>(items: readonly T[], rnd: () => number): T {
  return items[Math.floor(rnd() * items.length)]!;
}

function between(rnd: () => number, lo: number, hi: number): number {
  return lo + rnd() * (hi - lo);
}

/** Log-uniform, so base rates span orders of magnitude rather than clustering —
 *  which is what gives ABC three genuinely different classes. */
function logUniform(rnd: () => number, lo: number, hi: number): number {
  return Math.exp(between(rnd, Math.log(lo), Math.log(hi)));
}

function stockoutWindows(rnd: () => number, horizon: number, count: number): Window[] {
  const windows: Window[] = [];
  for (let i = 0; i < count; i++) {
    const length = Math.round(between(rnd, 7, 21));
    const from = Math.round(between(rnd, length + 5, horizon - 5));
    windows.push({ fromDaysAgo: from, toDaysAgo: Math.max(0, from - length) });
  }
  return windows;
}

function promoWindows(rnd: () => number, horizon: number, count: number, recent: boolean): Array<Window & { multiple: number }> {
  const promos: Array<Window & { multiple: number }> = [];
  for (let i = 0; i < count; i++) {
    // At least one promo inside the detector's fortnight, or the spike
    // suggestions screen has nothing to show.
    const from = recent && i === 0 ? Math.round(between(rnd, 3, 12)) : Math.round(between(rnd, 20, horizon - 5));
    const length = Math.round(between(rnd, 1, 3));
    promos.push({
      fromDaysAgo: from,
      toDaysAgo: Math.max(0, from - length),
      multiple: between(rnd, 3, 12),
    });
  }
  return promos;
}

/**
 * `cover` is DAYS of stock, not a unit count — on-hand is derived from the SKU's
 * own sales rate. A shop does not hold twenty units of something that sells one
 * a month, and a flat unit range makes almost the whole catalogue read as
 * slow-moving, which drowns the products that genuinely are.
 */
function shapeFor(archetype: Archetype, rnd: () => number, horizon: number) {
  switch (archetype) {
    case "hero":
      return { base: logUniform(rnd, 3, 12), trend: 0, first: horizon, last: 0, outs: 1, promos: 2, cover: [18, 45] };
    case "steady":
      return { base: logUniform(rnd, 0.8, 3), trend: 0, first: horizon, last: 0, outs: 1, promos: 1, cover: [20, 55] };
    case "slow":
      return { base: logUniform(rnd, 0.05, 0.5), trend: 0, first: horizon, last: 0, outs: 0, promos: 0, cover: [25, 70] };
    case "dead":
      // Sold for months, then nothing for a long stretch — with the stock still
      // on the shelf. Cover is meaningless once the rate is zero; what matters
      // is that real cash is sitting in it.
      return { base: logUniform(rnd, 0.3, 1.5), trend: 0, first: horizon, last: Math.round(between(rnd, 150, 240)), outs: 0, promos: 0, cover: [90, 200] };
    case "new":
      return { base: logUniform(rnd, 0.5, 3), trend: 0.002, first: Math.round(between(rnd, 20, 45)), last: 0, outs: 0, promos: 0, cover: [25, 60] };
    case "no-history":
      // Never sold: the cold-start path has to borrow a rate from somewhere.
      // No rate to derive from, so this one keeps a flat opening buy.
      return { base: 0, trend: 0, first: Math.round(between(rnd, 5, 30)), last: 0, outs: 0, promos: 0, cover: [0, 0] };
    case "riser":
      return { base: logUniform(rnd, 0.4, 2), trend: 0.0025, first: horizon, last: 0, outs: 0, promos: 1, cover: [20, 50] };
    case "faller":
      return { base: logUniform(rnd, 1, 4), trend: -0.0025, first: horizon, last: 0, outs: 0, promos: 0, cover: [30, 70] };
    case "overstocked":
      // Months of cover against a modest rate — what the overstock lens exists
      // to surface, and it should be the exception, not the catalogue.
      return { base: logUniform(rnd, 0.1, 0.6), trend: 0, first: horizon, last: 0, outs: 0, promos: 0, cover: [180, 400] };
  }
}

export function buildCatalogue(opts: { seed?: number; horizonDays: number }): SeedSku[] {
  const rnd = mulberry32(opts.seed ?? 20260728);
  const { horizonDays } = opts;
  const skus: SeedSku[] = [];
  let n = 0;

  for (const { archetype, count } of MIX) {
    for (let i = 0; i < count; i++) {
      n++;
      const family = FAMILIES[n % FAMILIES.length]!;
      const variant = pick(family.variants, rnd);
      const shape = shapeFor(archetype, rnd, horizonDays);
      const price = Math.round(between(rnd, family.price[0]!, family.price[1]!) / 10) * 10;

      // A handful of deliberate cost problems, spread across the catalogue:
      // eight with no cost at all, three priced below their own cost. Both are
      // held off the buy list, and both need to be visible on the cost screen.
      const costProblem = n % 50 === 0 ? "missing" : n % 130 === 0 ? "above-price" : "none";
      const costKes =
        costProblem === "missing"
          ? null
          : costProblem === "above-price"
            ? Math.round(price * 1.15)
            : Math.round(price * between(rnd, 0.55, 0.75));

      skus.push({
        sku: `WZ-${String(n).padStart(4, "0")}`,
        title: `${family.name} ${variant}`,
        archetype,
        priceKes: price,
        costKes,
        base: shape.base * RATE_SCALE,
        trendPerDay: shape.trend,
        firstSaleDaysAgo: Math.min(shape.first, horizonDays),
        lastSaleDaysAgo: shape.last,
        stockouts: stockoutWindows(rnd, horizonDays, shape.outs),
        promos: promoWindows(rnd, horizonDays, shape.promos, archetype === "hero"),
        seasonPhase: Math.round(between(rnd, 0, 365)),
        finalStock:
          archetype === "no-history"
            ? Math.round(between(rnd, 6, 24)) // an opening buy that never moved
            : Math.max(1, Math.round(shape.base * RATE_SCALE * between(rnd, shape.cover[0]!, shape.cover[1]!))),
      });
    }
  }

  // Currently out of stock: a slice of otherwise healthy SKUs with a stockout
  // window running up to today and nothing on hand. Days-left should read zero.
  for (let i = 0; i < 15; i++) {
    const sku = skus[hashString(`current-out-${i}`) % skus.length]!;
    if (sku.archetype === "no-history" || sku.archetype === "dead") continue;
    sku.stockouts.push({ fromDaysAgo: Math.round(between(rnd, 3, 12)), toDaysAgo: 0 });
    sku.finalStock = 0;
  }

  return skus;
}
