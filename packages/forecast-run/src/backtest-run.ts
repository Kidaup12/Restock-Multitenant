import { prismaForTenant, prismaForTenantTx } from "@wezesha/db";
import {
  assignAbc,
  dailySalesValue,
  walkForwardBacktest,
  walkForwardCutoffs,
  championsByClass,
  resolveChampions,
  type BacktestProduct,
  type BacktestResult,
  type DemandMethod,
  type SalesPoint,
} from "@wezesha/forecast";

/**
 * Monthly walk-forward backtest per tenant (spec §6): replay the forecast on the
 * shop's OWN history, score said-vs-happened in UNITS by ABC class, and persist
 * one BacktestRun row per (class × method) plus an "ALL" rollup. The same result
 * drives two things:
 *   - the champion audit — run rate reigns per class until a challenger beats it,
 *     recorded in TenantConfig.forecastChampions (the user never picks a model);
 *   - a degradation alert — a bell Notification (kind "accuracy_drop") when this
 *     run's error is materially worse than the previous one;
 *   - a method-change alert (kind "forecast_method_changed") when a class adopts
 *     a new winning method, since that shifts its order quantities.
 *
 * Single-tenant path: everything goes through the RLS-enforced tenant client.
 */

const DAY_MS = 86_400_000;
/** Sales history window fed to the backtest — a year covers the rate windows. */
const HISTORY_DAYS = 365;
/** Forecast horizon each hold-out window scores. */
export const DEFAULT_HORIZON_DAYS = 30;
/** Error worse than last run by this fraction trips the degradation alert. */
export const DEGRADATION_THRESHOLD = 0.25;
/** One accuracy_drop notification per tenant per rolling window. */
export const DROP_DEDUP_DAYS = 14;
/** One method-change notification per tenant per rolling window. */
export const METHOD_CHANGE_DEDUP_DAYS = 14;

/** How each ABC class reads to a shop owner — the audit never names a method. */
const CLASS_WORDS: Record<"A" | "B" | "C", string> = {
  A: "your bestsellers",
  B: "your steady sellers",
  C: "your slower movers",
};

/** The classes whose winning method changed between two audits. */
export function changedChampionClasses(
  prev: Record<"A" | "B" | "C", DemandMethod>,
  next: Record<"A" | "B" | "C", DemandMethod>
): Array<"A" | "B" | "C"> {
  return (["A", "B", "C"] as const).filter((c) => prev[c] !== next[c]);
}

/** Plain-language body for a method-change alert — order suggestions for the
 *  named groups may shift, said without a model name in sight. */
export function methodChangeBody(changed: Array<"A" | "B" | "C">): string {
  const groups = changed.map((c) => CLASS_WORDS[c]);
  const list =
    groups.length === 1
      ? groups[0]
      : `${groups.slice(0, -1).join(", ")} and ${groups[groups.length - 1]}`;
  return (
    `This month's accuracy review tuned how we size ${list}. ` +
    `Order suggestions for those products may look different from last month — ` +
    `it reflects how they've actually been selling.`
  );
}

export type BacktestRunOutcome = {
  /** Rows written (0 = not enough history for a single hold-out window). */
  rowsWritten: number;
  champions: Record<"A" | "B" | "C", DemandMethod> | null;
  /** True when this run wrote an accuracy_drop notification. */
  degraded: boolean;
  /** True when a class changed its winning method and an owner alert was written. */
  methodChanged: boolean;
  result: BacktestResult | null;
};

export async function runBacktest(
  tenantId: string,
  opts?: { horizonDays?: number; now?: Date }
): Promise<BacktestRunOutcome> {
  const db = prismaForTenant(tenantId);
  const now = opts?.now ?? new Date();
  const horizonDays = opts?.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const historySince = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);

  // One connection for both reads — see the note in packages/db on why a batch
  // through the per-operation client asks the pool for one connection per query.
  const { products, sales } = await prismaForTenantTx(
    tenantId,
    async (tx) => ({
      products: await tx.product.findMany({
        where: { active: true },
        select: { id: true, priceKes: true },
      }),
      sales: await tx.salesHistory.findMany({
        where: { date: { gte: historySince } },
        select: { productId: true, date: true, quantity: true },
      }),
    }),
    { maxWait: 30_000, timeout: 120_000 }
  );

  const historyByProduct = new Map<string, SalesPoint[]>();
  for (const row of sales) {
    let list = historyByProduct.get(row.productId);
    if (!list) historyByProduct.set(row.productId, (list = []));
    list.push(row);
  }

  // Not a second producer of the CURRENT class: the backtest scores past months
  // and needs the classes as they stood over the history it replays, which is
  // why it ranks its own slice rather than reading Product.abcCategory (today's
  // letter, written by the nightly run). Nothing user-facing reads these — they
  // only bucket accuracy scores inside BacktestRun.
  const abcByProduct = assignAbc(
    products.map((p) => ({
      id: p.id,
      revenue: dailySalesValue(historyByProduct.get(p.id) ?? [], p.priceKes),
    }))
  );

  const backtestProducts: BacktestProduct[] = products.map((p) => ({
    productId: p.id,
    abcClass: abcByProduct[p.id] ?? null,
    history: historyByProduct.get(p.id) ?? [],
  }));

  // Cutoffs shared across products, derived from the whole tenant's date range.
  const allPoints: SalesPoint[] = sales.map((s) => ({ date: s.date, quantity: s.quantity }));
  const cutoffs = walkForwardCutoffs(allPoints, horizonDays);
  if (cutoffs.length === 0) {
    return { rowsWritten: 0, champions: null, degraded: false, methodChanged: false, result: null };
  }

  const result = walkForwardBacktest(backtestProducts, cutoffs, horizonDays);
  const runDate = now;

  // Persist every scored (class × method) row, sharing one runDate.
  const rows = result.byClass
    .filter((r) => r.sampleSize > 0)
    .map((r) => ({
      tenantId,
      runDate,
      mae: r.mae,
      bias: r.bias,
      mape: r.mape,
      sampleSize: r.sampleSize,
      tag: "walkforward",
      abcClass: r.abcClass,
      method: r.method,
      saidUnits: r.saidUnits,
      happenedUnits: r.happenedUnits,
      leans: r.leans,
    }));
  if (rows.length === 0) {
    return { rowsWritten: 0, champions: null, degraded: false, methodChanged: false, result };
  }

  // Degradation check against the previous run's whole-shop champion accuracy,
  // BEFORE writing this run's rows.
  const prevAll = await db.backtestRun.findFirst({
    where: { tag: "walkforward", abcClass: "ALL", method: "run_rate" },
    orderBy: { runDate: "desc" },
    select: { mae: true },
  });
  const currentAll = result.byClass.find((r) => r.abcClass === "ALL" && r.method === "run_rate");
  const degradedNow =
    prevAll != null &&
    currentAll != null &&
    prevAll.mae > 0 &&
    currentAll.mae > prevAll.mae * (1 + DEGRADATION_THRESHOLD);

  await db.backtestRun.createMany({ data: rows });

  let degraded = false;
  if (degradedNow && currentAll) {
    const dedupSince = new Date(now.getTime() - DROP_DEDUP_DAYS * DAY_MS);
    const recent = await db.notification.findFirst({
      where: { kind: "accuracy_drop", createdAt: { gte: dedupSince } },
      select: { id: true },
    });
    if (!recent) {
      await db.notification.create({
        data: {
          tenantId,
          kind: "accuracy_drop",
          title: "Forecast accuracy dropped",
          body: accuracyDropBody(prevAll!.mae, currentAll.mae),
        },
      });
      degraded = true;
    }
  }

  // Champion audit: record the per-class champion for tonight's runs onward.
  // Read the old winners first — the upsert is about to overwrite them, and a
  // change is what the owner needs told, since it moves order quantities.
  const priorConfig = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { forecastChampions: true },
  });
  const prevChampions = resolveChampions(priorConfig?.forecastChampions);
  const champions = championsByClass(result);
  const changed = changedChampionClasses(prevChampions, champions);

  await db.tenantConfig.upsert({
    where: { tenantId },
    create: {
      tenantId,
      forecastChampions: { ...champions, auditedAt: now.toISOString() },
    },
    update: { forecastChampions: { ...champions, auditedAt: now.toISOString() } },
  });

  let methodChanged = false;
  if (changed.length > 0) {
    const dedupSince = new Date(now.getTime() - METHOD_CHANGE_DEDUP_DAYS * DAY_MS);
    const recent = await db.notification.findFirst({
      where: { kind: "forecast_method_changed", createdAt: { gte: dedupSince } },
      select: { id: true },
    });
    if (!recent) {
      await db.notification.create({
        data: {
          tenantId,
          kind: "forecast_method_changed",
          title: "We tuned your order suggestions",
          body: methodChangeBody(changed),
        },
      });
      methodChanged = true;
    }
  }

  return { rowsWritten: rows.length, champions, degraded, methodChanged, result };
}

/** Plain-language body for the degradation alert (units, not error %). */
export function accuracyDropBody(prevMae: number, currentMae: number): string {
  const worse = Math.round(((currentMae - prevMae) / prevMae) * 100);
  return (
    `The forecast's typical miss grew about ${worse}% since the last check ` +
    `(now roughly ${currentMae.toFixed(1)} units off per product). ` +
    `Check the accuracy page — a recent stockout, promo, or catalogue change can cause this.`
  );
}
