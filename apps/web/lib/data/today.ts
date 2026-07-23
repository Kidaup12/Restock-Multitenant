import { prismaForTenant } from "@wezesha/db";

/**
 * Today-screen queries. Server-only: every function takes an explicit tenantId
 * and runs on the RLS-enforced tenant client — no query here can read another
 * tenant's rows even if a `where` is wrong.
 */

const DAY_MS = 86_400_000;

/** No sale in this many days = dead stock, unless the tenant configured its own window. */
const DEFAULT_DEAD_STOCK_DAYS = 60;

export type TodayMetrics = {
  /** Sum of SalesHistory.revenueKes across all channels, trailing 30 days. */
  revenue30dKes: number;
  /** Same sum for the 30 days before that (delta baseline). */
  revenuePrev30dKes: number;
  /** Active products in the catalogue. */
  trackedProducts: number;
  /** Active products whose InventoryLevel rows sum to zero on-hand. */
  stockedOutProducts: number;
  /** Stock on the shelf with no sale inside the window: SKU count + cost tied up. */
  deadStock: { skus: number; costKes: number; windowDays: number };
};

export async function getTodayMetrics(tenantId: string): Promise<TodayMetrics> {
  const db = prismaForTenant(tenantId);
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY_MS);
  const since60 = new Date(now - 60 * DAY_MS);

  const [current, prior, products, levelSums, lastSales, config] = await Promise.all([
    db.salesHistory.aggregate({ _sum: { revenueKes: true }, where: { date: { gte: since30 } } }),
    db.salesHistory.aggregate({
      _sum: { revenueKes: true },
      where: { date: { gte: since60, lt: since30 } },
    }),
    db.product.findMany({ where: { active: true }, select: { id: true, costKes: true } }),
    db.inventoryLevel.groupBy({ by: ["productId"], _sum: { onHand: true } }),
    db.salesHistory.groupBy({ by: ["productId"], _max: { date: true } }),
    db.tenantConfig.findFirst({ select: { deadStockWindowDays: true } }),
  ]);

  const onHand = new Map(levelSums.map((l) => [l.productId, l._sum.onHand ?? 0]));
  const lastSale = new Map(lastSales.map((s) => [s.productId, s._max.date]));
  const windowDays = config?.deadStockWindowDays ?? DEFAULT_DEAD_STOCK_DAYS;
  const deadCutoff = now - windowDays * DAY_MS;

  let stockedOut = 0;
  let deadSkus = 0;
  let deadCostKes = 0;
  for (const p of products) {
    const units = onHand.get(p.id) ?? 0;
    if (units <= 0) {
      stockedOut += 1;
      continue; // an empty shelf can't be dead stock
    }
    const last = lastSale.get(p.id);
    if (!last || last.getTime() < deadCutoff) {
      deadSkus += 1;
      deadCostKes += units * p.costKes;
    }
  }

  return {
    revenue30dKes: current._sum.revenueKes ?? 0,
    revenuePrev30dKes: prior._sum.revenueKes ?? 0,
    trackedProducts: products.length,
    stockedOutProducts: stockedOut,
    deadStock: { skus: deadSkus, costKes: deadCostKes, windowDays },
  };
}

export type ReorderRow = {
  productId: string;
  sku: string;
  title: string;
  onHandUnits: number;
  daysUntilStockout: number;
  urgency: string;
  recommendedQty: number;
  /** recommendedQty x unit cost — what placing this order costs. */
  orderCostKes: number;
};

export type ReorderNeeded = {
  forecastRunId: string;
  runDate: Date;
  /** Products the latest run wants ordered, most urgent first. */
  rows: ReorderRow[];
  /** Total products covered by the run (for the "n of m" subtitle). */
  totalPredicted: number;
};

const URGENCY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** The latest forecast run's reorder list, or null when no run exists yet. */
export async function getReorderNeeded(
  tenantId: string,
  limit = 8
): Promise<ReorderNeeded | null> {
  const db = prismaForTenant(tenantId);
  const latest = await db.prediction.findFirst({
    orderBy: { runDate: "desc" },
    select: { forecastRunId: true, runDate: true },
  });
  if (!latest) return null;

  const predictions = await db.prediction.findMany({
    where: { forecastRunId: latest.forecastRunId },
    select: {
      productId: true,
      daysUntilStockout: true,
      urgency: true,
      recommendedQty: true,
      product: { select: { sku: true, title: true, costKes: true, currentStock: true } },
    },
  });

  const rows = predictions
    .filter((p) => p.recommendedQty > 0 || p.urgency === "critical" || p.urgency === "high")
    .sort(
      (a, b) =>
        (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9) ||
        a.daysUntilStockout - b.daysUntilStockout
    )
    .slice(0, limit)
    .map((p) => ({
      productId: p.productId,
      sku: p.product.sku,
      title: p.product.title,
      onHandUnits: p.product.currentStock,
      daysUntilStockout: p.daysUntilStockout,
      urgency: p.urgency,
      recommendedQty: Math.round(p.recommendedQty),
      orderCostKes: Math.round(p.recommendedQty) * p.product.costKes,
    }));

  return {
    forecastRunId: latest.forecastRunId,
    runDate: latest.runDate,
    rows,
    totalPredicted: predictions.length,
  };
}
