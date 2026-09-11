import { prismaForTenant } from "@wezesha/db";
import { runRate, type SalesPoint } from "@/lib/metrics";
import type { AbcCategory } from "@wezesha/forecast";
import { trailingWindow } from "@/lib/data/trailing-window";

/**
 * Sales-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout.
 *
 * `SalesHistory.date` is a day marker, and every window here is a day window —
 * but the column is a timestamp and not every writer stamps midnight, so
 * grouping by the raw column is NOT per-day grouping. Two rows a few hours
 * apart on the same day come back as two groups that then format to the same
 * key: one day rendered twice on the chart, counted twice in `tradingDays`.
 * Group by the key, not by the column.
 */

const DAY_MS = 86_400_000;
/** History span for the blended run rate — matches the engine's 30/90/365 windows. */
const RUN_RATE_HISTORY_DAYS = 365;

export type SalesDay = {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  unitsSold: number;
  revenueKes: number;
};

/** Per-day totals (all channels) for the trailing `days` days, oldest first.
 *  Days with no sales have no entry — charts should render from the dates given. */
export async function getSalesSeries(
  tenantId: string,
  days = 30,
  /** Injectable for tests; defaults to the wall clock. */
  now: Date = new Date(),
): Promise<SalesDay[]> {
  const db = prismaForTenant(tenantId);
  // The shared window, not `now - days`: an instant boundary keeps or drops its
  // own day depending on the hour the page loaded, and covers a day more than
  // the tile beside it.
  const { start } = trailingWindow(days, now);
  const grouped = await db.salesHistory.groupBy({
    by: ["date"],
    where: { date: { gte: start } },
    _sum: { quantity: true, revenueKes: true },
    orderBy: { date: "asc" },
  });

  const byDay = new Map<string, SalesDay>();
  for (const g of grouped) {
    const date = g.date.toISOString().slice(0, 10);
    const day = byDay.get(date) ?? { date, unitsSold: 0, revenueKes: 0 };
    day.unitsSold += g._sum.quantity ?? 0;
    day.revenueKes += g._sum.revenueKes ?? 0;
    byDay.set(date, day);
  }
  return [...byDay.values()];
}

export type SalesComparison = {
  /** Trailing `days` days of per-day totals, oldest first. */
  series: SalesDay[];
  /** Current-window totals. */
  revenueKes: number;
  unitsSold: number;
  /** Days inside the window that had any sale. */
  tradingDays: number;
  /** Revenue for the `days` days before the window (delta baseline). */
  priorRevenueKes: number;
  /** Days the window covers — what a per-day average must divide by. A screen
   *  that hard-codes 30 here reports the wrong average the moment it is asked
   *  for a different span. */
  windowDays: number;
};

/** The trailing window plus the window before it, split once here so screen
 *  components stay pure (no clock reads in render). */
export async function getSalesComparison(
  tenantId: string,
  days = 30,
  /** Injectable for tests; defaults to the wall clock. One instant for both
   *  halves, so the boundary cannot move between them. */
  now: Date = new Date(),
): Promise<SalesComparison> {
  const doubled = await getSalesSeries(tenantId, days * 2, now);
  // The shared boundary, as a day key — `doubled` is already grouped by day.
  const { startKey: cutoff } = trailingWindow(days, now);
  const series = doubled.filter((s) => s.date >= cutoff);
  return {
    series,
    revenueKes: series.reduce((sum, s) => sum + s.revenueKes, 0),
    unitsSold: series.reduce((sum, s) => sum + s.unitsSold, 0),
    tradingDays: series.length,
    windowDays: days,
    priorRevenueKes: doubled
      .filter((s) => s.date < cutoff)
      .reduce((sum, s) => sum + s.revenueKes, 0),
  };
}

export type MonthRevenue = {
  /** Calendar month key, YYYY-MM. */
  month: string;
  /** Short label for chart axes, e.g. "Jul". */
  label: string;
  unitsSold: number;
  revenueKes: number;
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Revenue rolled up by calendar month, oldest first, covering the current
 *  month and the `months - 1` before it. Months with no sales are included at
 *  zero so bar charts keep their axis. */
export async function getRevenueByMonth(tenantId: string, months = 3): Promise<MonthRevenue[]> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const db = prismaForTenant(tenantId);
  const grouped = await db.salesHistory.groupBy({
    by: ["date"],
    where: { date: { gte: start } },
    _sum: { quantity: true, revenueKes: true },
  });

  const buckets = new Map<string, { unitsSold: number; revenueKes: number }>();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    buckets.set(d.toISOString().slice(0, 7), { unitsSold: 0, revenueKes: 0 });
  }
  for (const g of grouped) {
    const key = g.date.toISOString().slice(0, 7);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.unitsSold += g._sum.quantity ?? 0;
    bucket.revenueKes += g._sum.revenueKes ?? 0;
  }

  return [...buckets.entries()].map(([month, totals]) => ({
    month,
    label: MONTH_LABELS[Number(month.slice(5, 7)) - 1] ?? month,
    ...totals,
  }));
}

export type TopProduct = {
  productId: string;
  sku: string;
  title: string;
  /** Units sold inside the revenue window. */
  unitsSold: number;
  /** Revenue (KES) over the window — the "revenue per product" metric. */
  revenueKes: number;
  /** Run rate — the ONE blended, all-channel engine rate (units/day), not a
   *  naive window average. Same number the forecast and stock screens show. */
  runRate: number;
  /** ABC class from the last forecast run; null when the product has not been
   *  classified yet (too new, or no run). Lets Reports show top earners per
   *  class without a second query. */
  abc: AbcCategory | null;
};

/** Best sellers by revenue over the trailing `days` days. */
export async function getTopProducts(
  tenantId: string,
  { days = 30, limit = 10 }: { days?: number; limit?: number } = {}
): Promise<TopProduct[]> {
  const db = prismaForTenant(tenantId);
  const now = new Date();
  // Same window as the chart and the tile: "best sellers over the last 30 days"
  // has to mean the same 30 days as everything else the page labels that way.
  const { start: since } = trailingWindow(days, now);
  const grouped = await db.salesHistory.groupBy({
    by: ["productId"],
    where: { date: { gte: since } },
    _sum: { quantity: true, revenueKes: true },
    orderBy: { _sum: { revenueKes: "desc" } },
    take: limit,
  });
  if (grouped.length === 0) return [];

  const productIds = grouped.map((g) => g.productId);
  // Full run-rate history for just the ranked products — the blended rate needs
  // the engine's 30/90/365 windows, not only the revenue window above.
  const runRateSince = new Date(now.getTime() - RUN_RATE_HISTORY_DAYS * DAY_MS);
  const [products, history] = await Promise.all([
    db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, title: true, abcCategory: true },
    }),
    db.salesHistory.findMany({
      where: { productId: { in: productIds }, date: { gte: runRateSince } },
      select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
    }),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const historyByProduct = new Map<string, SalesPoint[]>();
  for (const row of history) {
    let list = historyByProduct.get(row.productId);
    if (!list) historyByProduct.set(row.productId, (list = []));
    list.push(row);
  }

  return grouped.map((g) => {
    const product = byId.get(g.productId);
    return {
      productId: g.productId,
      sku: product?.sku ?? "—",
      title: product?.title ?? "Unknown product",
      unitsSold: g._sum.quantity ?? 0,
      revenueKes: g._sum.revenueKes ?? 0,
      runRate: runRate(historyByProduct.get(g.productId) ?? [], now),
      abc: (product?.abcCategory as AbcCategory | null) ?? null,
    };
  });
}
