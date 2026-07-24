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

import { runRateDaily } from "./layered";
import type { SalesPoint } from "./baseline";
import type { AbcCategory } from "./abc";

/** Demand methods in the audition. Run rate is the champion; recent_heavy is a
 *  more reactive challenger (trailing-30-day mean, no long-tail anchor). Adding
 *  a method here is all it takes to enter it in every class audition. */
export type DemandMethod = "run_rate" | "recent_heavy";
export const DEMAND_METHODS: readonly DemandMethod[] = ["run_rate", "recent_heavy"] as const;
export const CHAMPION_DEFAULT: DemandMethod = "run_rate";

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
};

const DAY_MS = 86_400_000;

/** Trailing-`days` mean daily rate before `cutoff` — the reactive challenger. */
function trailingMeanRate(history: SalesPoint[], cutoff: Date, days: number): number {
  const since = new Date(cutoff.getTime() - days * DAY_MS);
  const qty = history
    .filter((p) => p.date >= since && p.date < cutoff)
    .reduce((s, p) => s + p.quantity, 0);
  return qty / days;
}

/** A method's forecast daily rate as of a cutoff, from history strictly before it. */
export function methodDailyRate(method: DemandMethod, history: SalesPoint[], cutoff: Date): number {
  const past = history.filter((p) => p.date < cutoff);
  if (method === "recent_heavy") return trailingMeanRate(past, cutoff, 30);
  return runRateDaily(past, cutoff);
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

/** One class's accuracy for one method, from its per-window errors. */
function aggregate(
  abcClass: AbcCategory | "ALL",
  method: DemandMethod,
  windows: Array<{ said: number; happened: number }>
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
      }
    }
  }

  const byClass: ClassAccuracy[] = [];
  for (const [cls, byMethod] of buckets) {
    for (const [method, windows] of byMethod) {
      byClass.push(aggregate(cls, method, windows));
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
  let champion: DemandMethod = CHAMPION_DEFAULT;
  let bestMae = baseline.mae;
  for (const method of DEMAND_METHODS) {
    if (method === CHAMPION_DEFAULT) continue;
    const r = resultsByMethod[method];
    if (r && r.sampleSize > 0 && r.mae < baseline.mae * (1 - CHALLENGER_WIN_MARGIN) && r.mae < bestMae) {
      champion = method;
      bestMae = r.mae;
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
