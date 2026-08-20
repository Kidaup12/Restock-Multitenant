import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { getCatalogueMetrics } from "@/lib/metrics";
import { DEFAULT_DEAD_STOCK_DAYS, getTodayMetrics } from "./today";

/**
 * Insights-screen queries. Server-only: every function takes an explicit tenantId
 * and runs on the RLS-enforced tenant client.
 *
 * This screen defines NO metric of its own. Stocked-out and dead-stock counts come
 * from getTodayMetrics, per-product rate/cover/ABC from the shared metrics
 * contract — so Insights and Today can never disagree. Anything computed here is
 * a presentation of those numbers, not a second opinion on them.
 *
 * Cost fields are redacted here, not at render: rows are built on the real
 * numbers, then nulled on the way out when the caller can't view costs, so a
 * money-blind member's payload never carries them. Price × run rate is a sales
 * figure and stays visible.
 *
 * Ordering is redacted too. The idle-capital rows are ranked and then cut to a
 * page, so for a money-blind caller the ranking key must be cost-free — see
 * `byIdleUnits`.
 */

/** Below this rate the engine's cover is the 999 "effectively forever" sentinel,
 *  which must never reach a screen — show "—" instead (as the stock screen does). */
const NO_RATE_EPSILON = 0.0001;

/** Cover above this reads as over-bought rather than healthy. */
const OVERSTOCK_COVER_DAYS = 90;

export type EmptyShelfRow = {
  productId: string;
  sku: string;
  title: string;
  /** Blended run rate — what it sells on a normal day. */
  runRatePerDay: number;
  /** Units/day going unsold while the shelf is empty. */
  missedUnitsPerDay: number;
  /** runRate × price — a sales figure, visible to every role. */
  missedSalesKes: number;
  lastSoldAt: Date | null;
};

export type CashAsleepRow = {
  productId: string;
  sku: string;
  title: string;
  /** "not_selling" = no sale inside the dead-stock window; "too_much" = selling,
   *  but carrying more cover than OVERSTOCK_COVER_DAYS. */
  reason: "not_selling" | "too_much";
  onHandUnits: number;
  /** Null when the run rate is ~zero (no cover to measure) — never the sentinel. */
  coverDays: number | null;
  /** Cost × on-hand. Null when the caller can't view costs. */
  cashKes: number | null;
  /** False when the product has no cost recorded, so the row shows "—" not zero. */
  costKnown: boolean;
};

export type InsightsOverview = {
  stockouts: {
    /** Canonical count — the same number Today shows. */
    skus: number;
    trackedProducts: number;
    /** skus / trackedProducts, one decimal. */
    ratePct: number;
    /** Subset already counted in `skus` whose on-hand is negative, which the
     *  stock screen reports separately as "oversold". */
    oversoldSkus: number;
  };
  deadStock: { skus: number; costKes: number | null; windowDays: number };
  /** Empty shelves ranked by what they normally earn. */
  shelfRows: EmptyShelfRow[];
  /** Idle capital ranked by cash frozen. */
  cashRows: CashAsleepRow[];
  /** Total cash across every idle row, not just the returned page. */
  cashTotalKes: number | null;
  overstockCoverDays: number;
};

const redactCashRow = (r: CashAsleepRow): CashAsleepRow => ({ ...r, cashKes: null });

/** Cost viewer's ranking of idle capital: most cash frozen first. */
const byCashAtRest = (a: CashAsleepRow, b: CashAsleepRow): number =>
  (b.cashKes ?? 0) - (a.cashKes ?? 0) || a.sku.localeCompare(b.sku);

/**
 * Money-blind ranking: units sitting still, most first. Cash at rest is on-hand
 * × cost, so ranking on it and then slicing to a page hands a member two cost
 * facts — the order within the page, and which products made it in at all —
 * that survive nulling `cashKes`. On-hand is already on every row, so ordering
 * by it tells a member nothing they cannot read, and still puts the biggest
 * piles of unsold stock at the top.
 */
const byIdleUnits = (a: CashAsleepRow, b: CashAsleepRow): number =>
  b.onHandUnits - a.onHandUnits || a.sku.localeCompare(b.sku);

/**
 * The Overview tab in one pass: the two headline counts plus the rows behind
 * them. Deliberately one loader — it walks the catalogue once and takes the
 * canonical counts from a single getTodayMetrics call, which is what makes the
 * reconciliation with Today structural rather than a convention to remember.
 */
export async function getInsightsOverview(
  tenantId: string,
  { canViewCosts, limit = 8 }: { canViewCosts: boolean; limit?: number }
): Promise<InsightsOverview> {
  const db = prismaForTenant(tenantId);

  const [today, metrics, products, lastSales] = await Promise.all([
    getTodayMetrics(tenantId, { canViewCosts }),
    getCatalogueMetrics(tenantId),
    db.product.findMany({
      where: { ...BUYABLE_PRODUCT_WHERE },
      select: { id: true, sku: true, title: true, priceKes: true, costKes: true, currentStock: true },
    }),
    db.salesHistory.groupBy({ by: ["productId"], _max: { date: true } }),
  ]);

  const lastSale = new Map(lastSales.map((s) => [s.productId, s._max.date]));
  const deadCutoff = Date.now() - today.deadStock.windowDays * 86_400_000;

  const shelfRows: EmptyShelfRow[] = [];
  const cashRows: CashAsleepRow[] = [];
  let oversold = 0;
  let cashTotal = 0;

  for (const p of products) {
    const m = metrics.get(p.id);
    const rate = m?.runRate ?? 0;
    const onHand = p.currentStock;

    if (onHand <= 0) {
      if (onHand < 0) oversold += 1;
      shelfRows.push({
        productId: p.id,
        sku: p.sku,
        title: p.title,
        runRatePerDay: rate,
        missedUnitsPerDay: rate,
        missedSalesKes: rate * p.priceKes,
        lastSoldAt: lastSale.get(p.id) ?? null,
      });
      continue; // an empty shelf is a stockout, never idle cash
    }

    const last = lastSale.get(p.id);
    const idle = !last || last.getTime() < deadCutoff;
    const overBought = !idle && rate > NO_RATE_EPSILON && (m?.coverDays ?? 0) > OVERSTOCK_COVER_DAYS;
    if (!idle && !overBought) continue;

    const cash = m?.moneyAtRestKes ?? 0;
    cashTotal += cash;
    cashRows.push({
      productId: p.id,
      sku: p.sku,
      title: p.title,
      reason: idle ? "not_selling" : "too_much",
      onHandUnits: onHand,
      coverDays: rate > NO_RATE_EPSILON ? (m?.coverDays ?? null) : null,
      cashKes: cash,
      costKnown: p.costKes > 0,
    });
  }

  // Missed sales are price × run rate — a sales figure, so the shelf ranking is
  // the same for every role. Idle capital is ranked on cost, so it isn't.
  shelfRows.sort((a, b) => b.missedSalesKes - a.missedSalesKes);
  cashRows.sort(canViewCosts ? byCashAtRest : byIdleUnits);

  const pagedShelf = shelfRows.slice(0, limit);
  const pagedCash = cashRows.slice(0, limit);

  return {
    stockouts: {
      skus: today.stockedOutProducts,
      trackedProducts: today.trackedProducts,
      ratePct: today.trackedProducts
        ? Math.round((today.stockedOutProducts / today.trackedProducts) * 1000) / 10
        : 0,
      oversoldSkus: oversold,
    },
    deadStock: today.deadStock,
    shelfRows: pagedShelf,
    cashRows: canViewCosts ? pagedCash : pagedCash.map(redactCashRow),
    cashTotalKes: canViewCosts ? cashTotal : null,
    overstockCoverDays: OVERSTOCK_COVER_DAYS,
  };
}

export type AccuracyCheck = {
  runDate: Date;
  /** What the forecast said, in units. */
  saidUnits: number;
  /** What actually sold over the same window, in units. */
  happenedUnits: number;
  /** Plain-words bias band: the forecast ran high, low, or about right. */
  leans: "over" | "under" | "even";
  /** Product-windows scored in this check. */
  sampleSize: number;
};

export type AccuracyScorecard = {
  latest: AccuracyCheck | null;
  /** Oldest → newest, for the said-vs-happened bars. */
  history: AccuracyCheck[];
  checksAllTime: number;
  /** Earliest sale on record — the empty state uses it to say when the first
   *  check becomes possible, rather than an open-ended "coming soon". */
  firstSaleAt: Date | null;
  /** NEWEST sale on record. The check needs a SPAN of sales, not a span since
   *  the first one: a shop that stopped selling a fortnight ago gains no
   *  history by waiting, and telling it otherwise promises a check that cannot
   *  run (seen live — a store with 54 days of sales was told it had enough
   *  because 68 days had passed since its first). */
  lastSaleAt: Date | null;
};

/**
 * Days between the first and last sale before the walk-forward check can score
 * anything: a 30-day training minimum plus one 30-day horizon, less the day the
 * final window is inclusive of (`walkForwardCutoffs`). Below this there is not a
 * single cutoff to score.
 */
export const ACCURACY_MIN_HISTORY_DAYS = 59;

const LEANS = new Set(["over", "under", "even"]);

/**
 * The stored accuracy checks, in the units language the product settled on —
 * "we said X, you sold Y" plus a plain lean word. Error percentages (mae / bias /
 * mape) are deliberately never selected: they were rejected as unreadable, and
 * not fetching them makes rendering one impossible rather than merely discouraged.
 */
export async function getAccuracyScorecard(
  tenantId: string,
  { limit = 6 }: { limit?: number } = {}
): Promise<AccuracyScorecard> {
  const db = prismaForTenant(tenantId);

  // One row per (class × method) shares a runDate, so all three of tag, abcClass
  // and method must be pinned or a single check returns up to eight rows. This
  // mirrors the run's own whole-shop lookup.
  const where = {
    tag: "walkforward",
    abcClass: "ALL",
    method: "run_rate",
    saidUnits: { not: null },
    happenedUnits: { not: null },
  } as const;

  const [rows, checksAllTime, firstSale, lastSale] = await Promise.all([
    db.backtestRun.findMany({
      where,
      orderBy: { runDate: "desc" },
      take: limit,
      select: { runDate: true, saidUnits: true, happenedUnits: true, leans: true, sampleSize: true },
    }),
    db.backtestRun.count({ where }),
    db.salesHistory.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
    db.salesHistory.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
  ]);

  const history: AccuracyCheck[] = rows
    .filter((r) => r.sampleSize > 0 && LEANS.has(r.leans ?? ""))
    .map((r) => ({
      runDate: r.runDate,
      saidUnits: r.saidUnits as number,
      happenedUnits: r.happenedUnits as number,
      leans: r.leans as AccuracyCheck["leans"],
      sampleSize: r.sampleSize,
    }))
    .reverse();

  return {
    latest: history.length ? history[history.length - 1] : null,
    history,
    checksAllTime,
    firstSaleAt: firstSale?.date ?? null,
    lastSaleAt: lastSale?.date ?? null,
  };
}

/** Ordered quantity within this fraction of the ask counts as "what we said" —
 *  supplier pack sizes never land exactly on a forecast number. */
const ADHERENCE_TOLERANCE = 0.1;

export type PlanAdherence = {
  windowDays: number;
  /** Products the forecast asked for at least once in the window. */
  askedProducts: number;
  /** Of those, how many were ordered afterwards (any order or PO line). */
  actedProducts: number;
  /** Order lines raised in the app that carried a recommendation, split by how
   *  the quantity compared with it. Lines built by hand carry no ask and are
   *  excluded — `linesCompared` is the honest denominator. */
  linesCompared: number;
  boughtLess: number;
  boughtAsAsked: number;
  boughtMore: number;
  /** True once there is any history to read at all. */
  hasHistory: boolean;
};

/**
 * Did the shop act on what the forecast asked for? Read from
 * ForecastRecommendation, which is append-only — Prediction is replaced every
 * run, so it cannot answer a question about past weeks.
 *
 * Deliberately two separate measurements rather than one blended score: whether
 * an ask was acted on at all, and — only for lines raised in the app, which are
 * the only ones carrying the number we asked for — whether the quantity matched.
 * Orders cut outside the app are invisible to the second half, so the count it
 * is measured over is returned for the screen to show.
 */
export async function getPlanAdherence(
  tenantId: string,
  { windowDays = 60 }: { windowDays?: number } = {}
): Promise<PlanAdherence> {
  const db = prismaForTenant(tenantId);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const [asks, orders, poLines] = await Promise.all([
    db.forecastRecommendation.findMany({
      where: { runDate: { gte: since }, recommendedQty: { gt: 0 } },
      select: { productId: true, runDate: true },
    }),
    db.order.findMany({
      where: { createdAt: { gte: since }, status: { in: ["ordered", "completed"] } },
      select: { productId: true, createdAt: true },
    }),
    db.purchaseOrderLine.findMany({
      where: { recommendedQty: { not: null }, purchaseOrder: { createdAt: { gte: since } } },
      select: { productId: true, quantity: true, recommendedQty: true },
    }),
  ]);

  // Earliest ask per product — an order only counts if it came after we asked.
  const firstAsk = new Map<string, number>();
  for (const a of asks) {
    const at = a.runDate.getTime();
    const seen = firstAsk.get(a.productId);
    if (seen === undefined || at < seen) firstAsk.set(a.productId, at);
  }

  const acted = new Set<string>();
  for (const o of orders) {
    if (!o.productId) continue;
    const asked = firstAsk.get(o.productId);
    if (asked !== undefined && o.createdAt.getTime() >= asked) acted.add(o.productId);
  }
  for (const line of poLines) {
    if (firstAsk.has(line.productId)) acted.add(line.productId);
  }

  let boughtLess = 0;
  let boughtAsAsked = 0;
  let boughtMore = 0;
  for (const line of poLines) {
    const asked = line.recommendedQty;
    if (asked == null || asked <= 0) continue;
    const drift = (line.quantity - asked) / asked;
    if (drift < -ADHERENCE_TOLERANCE) boughtLess += 1;
    else if (drift > ADHERENCE_TOLERANCE) boughtMore += 1;
    else boughtAsAsked += 1;
  }

  return {
    windowDays,
    askedProducts: firstAsk.size,
    actedProducts: acted.size,
    linesCompared: boughtLess + boughtAsAsked + boughtMore,
    boughtLess,
    boughtAsAsked,
    boughtMore,
    hasHistory: asks.length > 0,
  };
}

/** A week needs this many days of snapshots before its rate is reported —
 *  below it the denominator is too thin to mean anything. */
const MIN_SNAPSHOT_DAYS_PER_WEEK = 5;

const DAY_MS = 86_400_000;

export type StockoutWeek = {
  /** Monday (UTC) of the week. */
  weekStart: Date;
  /** Product-days observed — the denominator. */
  observedProductDays: number;
  /** Of those, how many had nothing on the shelf. */
  emptyProductDays: number;
  /** empty / observed, as a percentage to one decimal. */
  ratePct: number;
  daysCovered: number;
};

export type StockoutTrend = {
  weeks: StockoutWeek[];
  /** First snapshot on record — the screen says when tracking began rather than
   *  implying the shop had no stockouts before it. */
  trackingSince: Date | null;
};

/** Monday (UTC) of the week a date falls in. */
function weekStartOf(d: Date): Date {
  const day = d.getUTCDay();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday;
}

/**
 * Empty-shelf rate week by week, from the nightly inventory snapshot. The
 * denominator is product-days actually observed, never an assumption: a day with
 * no snapshot is missing data, not a day when everything was in stock, so weeks
 * with too few days are dropped rather than reported thin. Discontinued products
 * leave the catalogue and stop being snapshotted, so they age out of the
 * denominator on their own.
 */
export async function getStockoutTrend(
  tenantId: string,
  { weeks = 8 }: { weeks?: number } = {}
): Promise<StockoutTrend> {
  const db = prismaForTenant(tenantId);
  const since = weekStartOf(new Date(Date.now() - weeks * 7 * 86_400_000));

  const [rows, earliest] = await Promise.all([
    db.inventorySnapshot.findMany({
      where: { date: { gte: since } },
      select: { date: true, onHand: true },
    }),
    db.inventorySnapshot.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
  ]);

  const byWeek = new Map<number, { observed: number; empty: number; days: Set<number> }>();
  for (const row of rows) {
    const key = weekStartOf(row.date).getTime();
    let bucket = byWeek.get(key);
    if (!bucket) byWeek.set(key, (bucket = { observed: 0, empty: 0, days: new Set() }));
    bucket.observed += 1;
    bucket.days.add(row.date.getTime());
    if (row.onHand <= 0) bucket.empty += 1;
  }

  const out: StockoutWeek[] = [];
  for (const [key, bucket] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    if (bucket.days.size < MIN_SNAPSHOT_DAYS_PER_WEEK) continue;
    out.push({
      weekStart: new Date(key),
      observedProductDays: bucket.observed,
      emptyProductDays: bucket.empty,
      ratePct: Math.round((bucket.empty / bucket.observed) * 1000) / 10,
      daysCovered: bucket.days.size,
    });
  }

  return { weeks: out, trackingSince: earliest?.date ?? null };
}

export type ImpactMeasure = {
  /** The first week we could measure after the shop started ordering. */
  start: number;
  /** The most recent week. */
  now: number;
  /** now − start. Negative is an improvement for both measures here, and the
   *  card says so rather than hiding it. */
  change: number;
  startWeek: Date;
  nowWeek: Date;
};

export type Impact = {
  /** When measuring began: the shop can only be judged from its first order. */
  since: Date | null;
  emptyShelfPct: ImpactMeasure | null;
  deadStockSkus: ImpactMeasure | null;
  deadStockWindowDays: number;
  /** First nightly snapshot on record — what limits how far back we can look. */
  trackingSince: Date | null;
  /** Why there is nothing to show yet, when there isn't. */
  reason: "no_order_yet" | "too_early" | null;
};

/**
 * "Has this made a difference?" — the two numbers the shop actually judges by:
 * how often shelves are empty, and how many products have stopped selling while
 * still taking up stock. First measurable week against the latest one.
 *
 * Deliberately not a shillings figure. Claiming money saved needs a
 * counterfactual — what would have happened without us — which nothing here
 * records, and a made-up number is the one thing the owner would quote back.
 *
 * Measuring starts at the first purchase order, not at sign-up: before the shop
 * has ordered anything on our say-so there is nothing to take credit or blame
 * for. Both measures ride the same weekly gate as the stockout trend, so a week
 * with too few nightly snapshots is missing data, never a good week.
 */
export async function getImpact(tenantId: string): Promise<Impact> {
  const db = prismaForTenant(tenantId);
  const [firstPo, config, trend] = await Promise.all([
    db.purchaseOrder.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.tenantConfig.findFirst({ select: { deadStockWindowDays: true } }),
    getStockoutTrend(tenantId, { weeks: 26 }),
  ]);

  const windowDays = config?.deadStockWindowDays ?? DEFAULT_DEAD_STOCK_DAYS;
  const base = {
    since: firstPo?.createdAt ?? null,
    emptyShelfPct: null,
    deadStockSkus: null,
    deadStockWindowDays: windowDays,
    trackingSince: trend.trackingSince,
  };
  if (!firstPo) return { ...base, reason: "no_order_yet" };

  const sinceWeek = weekStartOf(firstPo.createdAt).getTime();
  const weeks = trend.weeks.filter((w) => w.weekStart.getTime() >= sinceWeek);
  if (weeks.length < 2) return { ...base, reason: "too_early" };

  const first = weeks[0]!;
  const last = weeks[weeks.length - 1]!;
  const emptyShelfPct: ImpactMeasure = {
    start: first.ratePct,
    now: last.ratePct,
    change: Math.round((last.ratePct - first.ratePct) * 10) / 10,
    startWeek: first.weekStart,
    nowWeek: last.weekStart,
  };

  const deadCounts = await deadStockByWeek(
    tenantId,
    [first.weekStart, last.weekStart],
    windowDays
  );
  const startDead = deadCounts.get(first.weekStart.getTime());
  const nowDead = deadCounts.get(last.weekStart.getTime());
  const deadStockSkus: ImpactMeasure | null =
    startDead == null || nowDead == null
      ? null
      : {
          start: startDead,
          now: nowDead,
          change: nowDead - startDead,
          startWeek: first.weekStart,
          nowWeek: last.weekStart,
        };

  return { ...base, emptyShelfPct, deadStockSkus, reason: null };
}

/**
 * Dead-stock SKU count as it stood at the end of each named week, from the
 * nightly snapshot plus sales history — the same test Today applies to the
 * present moment (something on the shelf, nothing sold inside the window), asked
 * of a past date. Weeks with no snapshot are absent from the map, not zero.
 */
async function deadStockByWeek(
  tenantId: string,
  weekStarts: Date[],
  windowDays: number
): Promise<Map<number, number>> {
  const db = prismaForTenant(tenantId);
  const earliest = Math.min(...weekStarts.map((w) => w.getTime()));
  const [snapshots, sales] = await Promise.all([
    db.inventorySnapshot.findMany({
      where: { date: { gte: new Date(earliest) } },
      select: { date: true, productId: true, onHand: true },
    }),
    db.salesHistory.findMany({
      where: { date: { gte: new Date(earliest - windowDays * DAY_MS) } },
      select: { date: true, productId: true, quantity: true },
    }),
  ]);

  const soldDates = new Map<string, number[]>();
  for (const s of sales) {
    if (s.quantity <= 0) continue;
    const list = soldDates.get(s.productId);
    if (list) list.push(s.date.getTime());
    else soldDates.set(s.productId, [s.date.getTime()]);
  }

  const out = new Map<number, number>();
  for (const weekStart of weekStarts) {
    const weekEnd = weekStart.getTime() + 7 * DAY_MS;
    // The week's most recent nightly snapshot is the shelf as it stood then.
    let asOf = 0;
    for (const row of snapshots) {
      const t = row.date.getTime();
      if (t >= weekStart.getTime() && t < weekEnd && t > asOf) asOf = t;
    }
    if (asOf === 0) continue;

    const cutoff = asOf - windowDays * DAY_MS;
    let dead = 0;
    for (const row of snapshots) {
      if (row.date.getTime() !== asOf || row.onHand <= 0) continue;
      const dates = soldDates.get(row.productId);
      const lastSold = dates ? Math.max(...dates.filter((d) => d <= asOf)) : Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(lastSold) || lastSold < cutoff) dead += 1;
    }
    out.set(weekStart.getTime(), dead);
  }
  return out;
}
