import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { getBuyList } from "@/lib/data/plan";
import { trailingWindow } from "@/lib/data/trailing-window";
import { moneyAtRest } from "@/lib/metrics";

/**
 * Today-screen queries. Server-only: every function takes an explicit tenantId
 * and runs on the RLS-enforced tenant client — no query here can read another
 * tenant's rows even if a `where` is wrong.
 *
 * On-hand has ONE source: Product.currentStock (the sellable Sells-only rollup).
 * Stocked-out and dead-stock read that number, never a second sum of
 * InventoryLevel — a warehouse-heavy SKU is not "in stock" on the shelf, and the
 * capital-at-rest figure uses the shared moneyAtRest formula so it agrees with
 * the stock and plan screens exactly.
 *
 * Cost fields are redacted here, not at render: every getter takes an explicit
 * `canViewCosts` and returns null for cost figures when it is false, so a
 * money-blind member's payload never carries the numbers. Revenue is a sales
 * figure and stays visible.
 */

const DAY_MS = 86_400_000;

/** No sale in this many days = dead stock, unless the tenant configured its own
 *  window (spec §11 default: 90 days). Exported so the Settings screen shows
 *  the same number this getter falls back to. */
export const DEFAULT_DEAD_STOCK_DAYS = 90;

export type TodayMetrics = {
  /** Sum of SalesHistory.revenueKes across all channels, trailing 30 days. */
  revenue30dKes: number;
  /** Same sum for the 30 days before that (delta baseline). */
  revenuePrev30dKes: number;
  /** Active products in the catalogue. */
  trackedProducts: number;
  /** Active products with no sellable on-hand (Product.currentStock <= 0). */
  stockedOutProducts: number;
  /** Stock on the shelf with no sale inside the window: SKU count + cost tied
   *  up. Cost is null when the caller can't view costs. */
  deadStock: { skus: number; costKes: number | null; windowDays: number };
};

export async function getTodayMetrics(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<TodayMetrics> {
  const db = prismaForTenant(tenantId);
  // Both this tile and the chart under it read the same window definition, so
  // the two cannot disagree about what "last 30 days" means.
  const { start: since30, priorStart: since60 } = trailingWindow(30);

  const [current, prior, products, lastSales, config] = await Promise.all([
    db.salesHistory.aggregate({ _sum: { revenueKes: true }, where: { date: { gte: since30 } } }),
    db.salesHistory.aggregate({
      _sum: { revenueKes: true },
      where: { date: { gte: since60, lt: since30 } },
    }),
    db.product.findMany({ where: { ...BUYABLE_PRODUCT_WHERE }, select: { id: true, costKes: true, currentStock: true } }),
    db.salesHistory.groupBy({ by: ["productId"], _max: { date: true } }),
    db.tenantConfig.findFirst({ select: { deadStockWindowDays: true } }),
  ]);

  const lastSale = new Map(lastSales.map((s) => [s.productId, s._max.date]));
  const windowDays = config?.deadStockWindowDays ?? DEFAULT_DEAD_STOCK_DAYS;
  const deadCutoff = Date.now() - windowDays * DAY_MS;

  let stockedOut = 0;
  let deadSkus = 0;
  let deadCostKes = 0;
  for (const p of products) {
    const units = p.currentStock; // sellable on-hand — the single source
    if (units <= 0) {
      stockedOut += 1;
      continue; // an empty shelf can't be dead stock
    }
    const last = lastSale.get(p.id);
    if (!last || last.getTime() < deadCutoff) {
      deadSkus += 1;
      deadCostKes += moneyAtRest(p.costKes, units);
    }
  }

  return {
    revenue30dKes: current._sum.revenueKes ?? 0,
    revenuePrev30dKes: prior._sum.revenueKes ?? 0,
    trackedProducts: products.length,
    stockedOutProducts: stockedOut,
    deadStock: { skus: deadSkus, costKes: canViewCosts ? deadCostKes : null, windowDays },
  };
}

export type ReorderRow = {
  productId: string;
  sku: string;
  title: string;
  onHandUnits: number;
  /** Null when the run rate is ~zero and no stockout is in sight. */
  daysUntilStockout: number | null;
  urgency: string;
  recommendedQty: number;
  /** What placing this line costs — the buy list's own figure, so it carries the
   *  supplier MOQ floor and the same redaction. Null when the caller can't view
   *  costs. */
  orderCostKes: number | null;
};

export type ReorderNeeded = {
  forecastRunId: string;
  runDate: Date;
  /** Products the latest run wants ordered, most urgent first. Capped — this is
   *  a dashboard card, not the buy list. Count with `needingRestock`. */
  rows: ReorderRow[];
  /** How many products need restocking in total. `rows` is the top few of
   *  these; reporting `rows.length` instead said "8 of 30" on a morning the
   *  planner said 14, because the cap was applied before anything counted. */
  needingRestock: number;
  /** Total products covered by the run (for the "n of m" subtitle). */
  totalPredicted: number;
  /** How many of the products needing restock are critical. Counted off the
   *  full list, not the handful this card shows, so the warning above the table
   *  and the planner agree. */
  criticalCount: number;
};

/**
 * The latest run's reorder list, or null when no run exists yet.
 *
 * One definition of "needs restocking", shared with the planner. Today used to
 * apply a filter of its own AND cap the list before counting it, so the two
 * screens answered the morning's first question with different numbers over
 * different products: "8 of 30" on a day the planner said 14. The dashboard now
 * shows the top few of the planner's own active rows, so the count and the
 * membership agree by construction — and the held-back groups (already ordered,
 * cost needs checking, too slow to stock now) are excluded from both.
 */
export async function getReorderNeeded(
  tenantId: string,
  { canViewCosts, limit = 8 }: { canViewCosts: boolean; limit?: number }
): Promise<ReorderNeeded | null> {
  const buyList = await getBuyList(tenantId, { canViewCosts });
  if (!buyList) return null;

  return {
    forecastRunId: buyList.forecastRunId,
    runDate: buyList.runDate,
    rows: buyList.rows.slice(0, limit).map((r) => ({
      productId: r.productId,
      sku: r.sku,
      title: r.title,
      onHandUnits: r.onHandUnits,
      daysUntilStockout: r.daysUntilStockout,
      urgency: r.urgency,
      recommendedQty: r.recommendedQty,
      orderCostKes: r.lineTotalKes,
    })),
    needingRestock: buyList.rows.length,
    totalPredicted: buyList.totalPredicted,
    criticalCount: buyList.rows.filter((r) => r.urgency === "critical").length,
  };
}
