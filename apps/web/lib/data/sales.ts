import { prismaForTenant } from "@wezesha/db";

/**
 * Sales-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout. Seeded/synced SalesHistory dates are UTC midnights, so
 * grouping by the raw date column IS per-day grouping.
 */

const DAY_MS = 86_400_000;

export type SalesDay = {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  unitsSold: number;
  revenueKes: number;
};

/** Per-day totals (all channels) for the trailing `days` days, oldest first.
 *  Days with no sales have no entry — charts should render from the dates given. */
export async function getSalesSeries(tenantId: string, days = 30): Promise<SalesDay[]> {
  const db = prismaForTenant(tenantId);
  const since = new Date(Date.now() - days * DAY_MS);
  const grouped = await db.salesHistory.groupBy({
    by: ["date"],
    where: { date: { gte: since } },
    _sum: { quantity: true, revenueKes: true },
    orderBy: { date: "asc" },
  });
  return grouped.map((g) => ({
    date: g.date.toISOString().slice(0, 10),
    unitsSold: g._sum.quantity ?? 0,
    revenueKes: g._sum.revenueKes ?? 0,
  }));
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
};

/** The trailing window plus the window before it, split once here so screen
 *  components stay pure (no clock reads in render). */
export async function getSalesComparison(tenantId: string, days = 30): Promise<SalesComparison> {
  const doubled = await getSalesSeries(tenantId, days * 2);
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const series = doubled.filter((s) => s.date >= cutoff);
  return {
    series,
    revenueKes: series.reduce((sum, s) => sum + s.revenueKes, 0),
    unitsSold: series.reduce((sum, s) => sum + s.unitsSold, 0),
    tradingDays: series.length,
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
  unitsSold: number;
  revenueKes: number;
  /** Average units/day over the window. */
  runRatePerDay: number;
};

/** Best sellers by revenue over the trailing `days` days. */
export async function getTopProducts(
  tenantId: string,
  { days = 30, limit = 10 }: { days?: number; limit?: number } = {}
): Promise<TopProduct[]> {
  const db = prismaForTenant(tenantId);
  const since = new Date(Date.now() - days * DAY_MS);
  const grouped = await db.salesHistory.groupBy({
    by: ["productId"],
    where: { date: { gte: since } },
    _sum: { quantity: true, revenueKes: true },
    orderBy: { _sum: { revenueKes: "desc" } },
    take: limit,
  });
  if (grouped.length === 0) return [];

  const products = await db.product.findMany({
    where: { id: { in: grouped.map((g) => g.productId) } },
    select: { id: true, sku: true, title: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  return grouped.map((g) => {
    const product = byId.get(g.productId);
    const unitsSold = g._sum.quantity ?? 0;
    return {
      productId: g.productId,
      sku: product?.sku ?? "—",
      title: product?.title ?? "Unknown product",
      unitsSold,
      revenueKes: g._sum.revenueKes ?? 0,
      runRatePerDay: unitsSold / days,
    };
  });
}
