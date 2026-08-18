/**
 * Walk-forward backtest — the shop grading itself on its own history (spec §6).
 *
 * For each hold-out cutoff we forecast the next `horizonDays` using ONLY the
 * sales before the cutoff, then compare said-vs-happened in UNITS (not error %,
 * which the founder rejected as unreadable). Results roll up BY ABC CLASS: a
 * champion for A needs different evidence than the long tail on C.
 *
 * The same harness auditions demand METHODS: run rate is the reigning champion,
 * and a challenger only earns a class by beating run rate on the shop's own
 * history by a real margin. The user never sees a model name — this just records
 * which method wins, so the run can quietly use the shop's best fit.
 *
 * Pure: the caller loads each product's history + ABC class and the cutoffs.
 */

import { demandRateFor, CHAMPION_DEFAULT, type DemandMethod } from "./layered";
import type { SalesPoint } from "./baseline";
import type { AbcCategory } from "./abc";
import { scaleFreeAccuracy, type ScaleFreeAccuracy, type WindowError } from "./accuracy";

/** Demand methods in the audition. Run rate is the champion; recent_heavy is a
 *  more reactive challenger (trailing-30-day mean, no long-tail anchor). Adding
 *  a method here is all it takes to enter it in every class audition. */
export type { DemandMethod };
export { CHAMPION_DEFAULT };
export const DEMAND_METHODS: readonly DemandMethod[] = ["run_rate", "recent_heavy"] as const;

/** A challenger must beat run rate's MAE by at least this fraction to take a
 *  class — no style change without a real receipt (spec §6). */
export const CHALLENGER_WIN_MARGIN = 0.1;

export type BacktestProduct = {
  productId: string;
  abcClass: AbcCategory | null;
  history: SalesPoint[];
};

/** Which way a class's forecast leans against reality. */
export type Lean = "over" | "under" | "even";

export type ClassAccuracy = {
  /** "A" | "B" | "C" per class, "ALL" for the whole-shop rollup. */
  abcClass: AbcCategory | "ALL";
  method: DemandMethod;
  /** Total forecast units across all product-windows (what we said). */
  saidUnits: number;
  /** Total actual units across all product-windows (what happened). */
  happenedUnits: number;
  /** Mean absolute error per product-window, in units. */
  mae: number;
  /** Mean signed error (said − happened) per window, units. Positive = over-forecast. */
  bias: number;
  /** Mean absolute percentage error over windows with real demand; null if none. */
  mape: number | null;
  /** Number of product-windows scored. */
  sampleSize: number;
  leans: Lean;
  /** Scale-free accuracy, averaged over the products in this class so a busy
   *  product cannot drown a quiet one. Null where no product could supply a
   *  scale (every history in the class was flat). */
  scaleFree: ScaleFreeAccuracy;
};

const DAY_MS = 86_400_000;

/** A method's forecast daily rate as of a cutoff, from history strictly before
 *  it. Runs the same dispatch the nightly forecast does, so a method that wins
 *  a class here behaves the same way when the run adopts it. */
export function methodDailyRate(method: DemandMethod, history: SalesPoint[], cutoff: Date): number {
  return demandRateFor(method, history.filter((p) => p.date < cutoff), cutoff);
}

/** Actual units sold in [cutoff, cutoff + horizonDays). */
function actualUnits(history: SalesPoint[], cutoff: Date, horizonDays: number): number {
  const end = new Date(cutoff.getTime() + horizonDays * DAY_MS);
  return history
    .filter((p) => p.date >= cutoff && p.date < end)
    .reduce((s, p) => s + p.quantity, 0);
}

/**
 * Evenly spaced hold-out cutoffs from a history range: each leaves at least
 * `minTrainDays` of history behind it and a full `horizonDays` of actuals ahead.
 * The most recent windows are kept when there are more than `maxWindows`.
 */
export function walkForwardCutoffs(
  history: SalesPoint[],
  horizonDays: number,
  opts?: { minTrainDays?: number; step?: number; maxWindows?: number }
): Date[] {
  if (history.length === 0) return [];
  const minTrain = opts?.minTrainDays ?? 30;
  const step = opts?.step ?? 15;
  const maxWindows = opts?.maxWindows ?? 4;

  let earliest = history[0]!.date.getTime();
  let latest = earliest;
  for (const p of history) {
    const t = p.date.getTime();
    if (t < earliest) earliest = t;
    if (t > latest) latest = t;
  }

  const first = earliest + minTrain * DAY_MS;
  const last = latest - horizonDays * DAY_MS + DAY_MS; // inclusive of the final full window
  const cutoffs: Date[] = [];
  for (let t = first; t <= last; t += step * DAY_MS) cutoffs.push(new Date(t));
  return cutoffs.length > maxWindows ? cutoffs.slice(cutoffs.length - maxWindows) : cutoffs;
}

function lean(bias: number, happenedUnits: number, sampleSize: number): Lean {
  if (sampleSize === 0) return "even";
  const scale = happenedUnits > 0 ? happenedUnits / sampleSize : 1;
  const rel = bias / (scale || 1);
  if (rel > 0.05) return "over";
  if (rel < -0.05) return "under";
  return "even";
}

/** The service quantile the pinball loss prices under-forecasting at — the same
 *  level the order-up-to rules aim for. */
const PINBALL_TAU = 0.95;

/** A product's sales as one value per day, zeros included. The scales in
 *  `accuracy` measure how much a series moves, so the quiet days have to be
 *  present — a sparse list of sale days would look like a steady seller. */
function densify(history: SalesPoint[]): number[] {
  if (history.length === 0) return [];
  let first = history[0]!.date.getTime();
  let last = first;
  for (const p of history) {
    const t = p.date.getTime();
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const days = Math.round((last - first) / DAY_MS) + 1;
  const daily = new Array<number>(days).fill(0);
  for (const p of history) {
    daily[Math.round((p.date.getTime() - first) / DAY_MS)]! += p.quantity;
  }
  return daily;
}

/** Mean of the values that exist, or null when none do. */
function meanOf(values: Array<number | null>): number | null {
  const real = values.filter((v): v is number => v != null && Number.isFinite(v));
  return real.length > 0 ? real.reduce((s, v) => s + v, 0) / real.length : null;
}

/** Pool per-product scale-free scores with equal weight per product. */
function poolScaleFree(perProduct: ScaleFreeAccuracy[]): ScaleFreeAccuracy {
  return {
    mase: meanOf(perProduct.map((s) => s.mase)),
    rmsse: meanOf(perProduct.map((s) => s.rmsse)),
    pinball: meanOf(perProduct.map((s) => s.pinball)),
  };
}

/** One class's accuracy for one method, from its per-window errors. */
function aggregate(
  abcClass: AbcCategory | "ALL",
  method: DemandMethod,
  windows: Array<{ said: number; happened: number }>,
  perProductScaleFree: ScaleFreeAccuracy[]
): ClassAccuracy {
  const sampleSize = windows.length;
  const saidUnits = windows.reduce((s, w) => s + w.said, 0);
  const happenedUnits = windows.reduce((s, w) => s + w.happened, 0);
  const absErr = windows.reduce((s, w) => s + Math.abs(w.said - w.happened), 0);
  const signedErr = windows.reduce((s, w) => s + (w.said - w.happened), 0);
  const mae = sampleSize > 0 ? absErr / sampleSize : 0;
  const bias = sampleSize > 0 ? signedErr / sampleSize : 0;
  const withDemand = windows.filter((w) => w.happened > 0);
  const mape =
    withDemand.length > 0
      ? withDemand.reduce((s, w) => s + Math.abs(w.said - w.happened) / w.happened, 0) /
        withDemand.length
      : null;
  return {
    abcClass,
    method,
    saidUnits,
    happenedUnits,
    mae,
    bias,
    mape,
    sampleSize,
    leans: lean(bias, happenedUnits, sampleSize),
    scaleFree: poolScaleFree(perProductScaleFree),
  };
}

export type BacktestResult = {
  horizonDays: number;
  /** Per (class × method) accuracy, plus the "ALL" rollup per method. */
  byClass: ClassAccuracy[];
};

/**
 * Walk-forward the whole catalogue for every demand method. Each product is
 * scored at every cutoff whose horizon window falls inside its history; results
 * roll up per ABC class and per method, with an "ALL" rollup.
 */
export function walkForwardBacktest(
  products: BacktestProduct[],
  cutoffs: Date[],
  horizonDays: number
): BacktestResult {
  // class -> method -> windows
  const buckets = new Map<AbcCategory | "ALL", Map<DemandMethod, Array<{ said: number; happened: number }>>>();
  // class -> method -> one scale-free score per product
  const scaled = new Map<AbcCategory | "ALL", Map<DemandMethod, ScaleFreeAccuracy[]>>();
  const pushScaled = (cls: AbcCategory | "ALL", method: DemandMethod, score: ScaleFreeAccuracy) => {
    let byMethod = scaled.get(cls);
    if (!byMethod) scaled.set(cls, (byMethod = new Map()));
    let list = byMethod.get(method);
    if (!list) byMethod.set(method, (list = []));
    list.push(score);
  };
  const push = (
    cls: AbcCategory | "ALL",
    method: DemandMethod,
    said: number,
    happened: number
  ) => {
    let byMethod = buckets.get(cls);
    if (!byMethod) buckets.set(cls, (byMethod = new Map()));
    let list = byMethod.get(method);
    if (!list) byMethod.set(method, (list = []));
    list.push({ said, happened });
  };

  for (const product of products) {
    const cls: AbcCategory = product.abcClass ?? "C";
    const daily = densify(product.history);
    const own = new Map<DemandMethod, WindowError[]>();
    for (const cutoff of cutoffs) {
      // Skip cutoffs whose horizon runs past the product's own history end.
      const end = new Date(cutoff.getTime() + horizonDays * DAY_MS);
      const lastDate = product.history.reduce((m, p) => (p.date > m ? p.date : m), new Date(0));
      if (product.history.length === 0 || end.getTime() > lastDate.getTime() + DAY_MS) continue;
      const happened = actualUnits(product.history, cutoff, horizonDays);
      for (const method of DEMAND_METHODS) {
        const said = methodDailyRate(method, product.history, cutoff) * horizonDays;
        push(cls, method, said, happened);
        push("ALL", method, said, happened);
        let mine = own.get(method);
        if (!mine) own.set(method, (mine = []));
        mine.push({ said, happened });
      }
    }
    for (const [method, windows] of own) {
      const score = scaleFreeAccuracy(windows, daily, PINBALL_TAU);
      pushScaled(cls, method, score);
      pushScaled("ALL", method, score);
    }
  }

  const byClass: ClassAccuracy[] = [];
  for (const [cls, byMethod] of buckets) {
    for (const [method, windows] of byMethod) {
      byClass.push(aggregate(cls, method, windows, scaled.get(cls)?.get(method) ?? []));
    }
  }
  return { horizonDays, byClass };
}

/**
 * The champion for a class: run rate unless a challenger beat it by the margin
 * on this shop's own history. Stateless per audit — run rate is always the
 * baseline a challenger must clear, so the champion only changes on a real win.
 */
export function auditChampion(resultsByMethod: Partial<Record<DemandMethod, ClassAccuracy>>): DemandMethod {
  const baseline = resultsByMethod[CHAMPION_DEFAULT];
  if (!baseline || baseline.sampleSize === 0) return CHAMPION_DEFAULT;

  // Judge on RMSSE where the histories could supply a scale. Mean absolute
  // error is minimised by the median, which on a shop's intermittent long tail
  // is zero — it would hand the class to whichever method stops forecasting.
  // RMSSE answers to the mean, so missing the spikes is what costs a method.
  // MAE remains the fallback for a class too flat to scale, where the two rank
  // the same anyway.
  // One basis for the whole audit — mixing an RMSSE against a MAE compares
  // numbers in different units and picks a winner by accident.
  const contenders = DEMAND_METHODS.map((m) => resultsByMethod[m]).filter(
    (r): r is ClassAccuracy => r != null && r.sampleSize > 0
  );
  const onRmsse = contenders.every((r) => r.scaleFree.rmsse != null);
  const scoreOf = (r: ClassAccuracy): number => (onRmsse ? r.scaleFree.rmsse! : r.mae);

  let champion: DemandMethod = CHAMPION_DEFAULT;
  const incumbent = scoreOf(baseline);
  let best = incumbent;
  for (const method of DEMAND_METHODS) {
    if (method === CHAMPION_DEFAULT) continue;
    const r = resultsByMethod[method];
    if (!r || r.sampleSize === 0) continue;
    const challenger = scoreOf(r);
    if (challenger < incumbent * (1 - CHALLENGER_WIN_MARGIN) && challenger < best) {
      champion = method;
      best = challenger;
    }
  }
  return champion;
}

/** Champion per ABC class from a full backtest result. */
export function championsByClass(result: BacktestResult): Record<AbcCategory, DemandMethod> {
  const pick = (cls: AbcCategory): DemandMethod => {
    const byMethod: Partial<Record<DemandMethod, ClassAccuracy>> = {};
    for (const row of result.byClass) {
      if (row.abcClass === cls) byMethod[row.method] = row;
    }
    return auditChampion(byMethod);
  };
  return { A: pick("A"), B: pick("B"), C: pick("C") };
}
