import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { getBuyList } from "@/lib/data/plan";
import { getStockCatalogue, type CatalogueRow } from "@/lib/data/stock";
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

/**
 * Which pile a product sits in. ONE rule, used by the KPI tiles and by the
 * tabbed table beneath them — they sit on the same screen, so a tile reading 7
 * beside a tab listing 9 is a bug the reader cannot resolve.
 *
 * Note this is NOT the catalogue's `dead` health flag, which asks a different
 * question ("has stock and a run rate of ~zero") for a different screen. This
 * one is "has stock and has not sold inside the shop's own window", which is
 * the figure the shop configures and the one Today reports.
 */
export type ProductPile = "stockout" | "dead" | "healthy";

export function pileFor(
  product: { onHandUnits: number; lastSaleAt: Date | null },
  deadCutoffMs: number
): ProductPile {
  // An empty shelf cannot also be dead stock — it is the more urgent fact, and
  // counting it twice would make the piles sum past the catalogue.
  if (product.onHandUnits <= 0) return "stockout";
  const last = product.lastSaleAt;
  if (last == null || last.getTime() < deadCutoffMs) return "dead";
  return "healthy";
}

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
    // Sellable on-hand — the single source.
    const pile = pileFor(
      { onHandUnits: p.currentStock, lastSaleAt: lastSale.get(p.id) ?? null },
      deadCutoff
    );
    if (pile === "stockout") stockedOut += 1;
    else if (pile === "dead") {
      deadSkus += 1;
      deadCostKes += moneyAtRest(p.costKes, p.currentStock);
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


/** The five piles the dashboard table tabs between. */
export type DashboardTab = "stockout" | "reorder" | "onway" | "dead" | "all";

/**
 * One dead-stock line as the CSV wants it. The dashboard table caps its dead
 * pile at the row limit and shows cost/capital only; the download is the whole
 * pile with the last-sale facts the export names, so the file is not "the
 * twenty-five rows you happen to be looking at".
 *
 * Value at cost carries the same redaction as everywhere else — null for a
 * money-blind caller. Value at retail is price × on-hand, a sales figure, so it
 * stays visible to every role.
 */
export type DeadStockExportRow = {
  sku: string;
  title: string;
  vendor: string | null;
  onHandUnits: number;
  lastSaleAt: Date | null;
  /** Whole days since the last sale; null when nothing has ever sold. */
  daysSinceLastSale: number | null;
  /** cost × on-hand — the same money-at-rest figure the tab shows. Null for a
   *  money-blind caller. */
  valueAtCostKes: number | null;
  /** price × on-hand — a sales figure, visible to every role. */
  valueAtRetailKes: number;
};

export type DashboardTable = {
  /** Full counts — the tab pills and the health panel read these, never the
   *  length of the capped rows below. */
  counts: Record<DashboardTab, number>;
  /** Products in none of the four problem piles. */
  healthy: number;
  /** The rows themselves, capped: this is a dashboard, not the catalogue. */
  rows: Record<DashboardTab, CatalogueRow[]>;
  /** The shop's own dead-stock window, so the tab can say what it means. */
  deadWindowDays: number;
  /** Cash sitting in stock that is not selling — one of the two numbers this
   *  shop judges the product by, so it leads its card rather than the SKU
   *  count. Null for a money-blind caller. */
  deadCostKes: number | null;
  /** Buy-list lines that cannot wait. Counted over the whole list, not the
   *  capped rows, so the warning above the table matches the planner. */
  criticalCount: number;
  /** What those critical lines cost to order. A count says how many fires
   *  there are; the money says whether the shop can put them out this week —
   *  and that is the decision the banner is actually for. Null for a
   *  money-blind caller. */
  criticalCostKes: number | null;
  /** True when a pile had more rows than the cap, so the screen can say so
   *  rather than quietly showing a prefix. */
  capped: Record<DashboardTab, boolean>;
  /** The FULL dead pile for the CSV — every dead row, not the capped page the
   *  `dead` tab renders — ranked by frozen cash (cost when visible, else
   *  retail) so the file leads with the most capital sitting still. */
  deadStockExport: DeadStockExportRow[];
};

const DASHBOARD_ROW_CAP = 25;

/**
 * The dashboard's product table, in five piles.
 *
 * Built on the catalogue getter, so every figure on a row (cover, run rate,
 * money at rest, en route) is the one the Stock screen shows and is already
 * redacted for a money-blind caller. What this adds is the PILING, and it uses
 * `pileFor` — the same rule the KPI tiles above the table count with, so the
 * tile and the tab can never disagree.
 *
 * "Reorder" is the exception and deliberately so: it comes from the buy list,
 * which is the one definition of "needs restocking" in the app. Deriving it
 * here from stock and run rate would be a second producer for that number, and
 * that has already cost this project once.
 */
export async function getDashboardTable(
  tenantId: string,
  { canViewCosts, limit = DASHBOARD_ROW_CAP }: { canViewCosts: boolean; limit?: number }
): Promise<DashboardTable> {
  const db = prismaForTenant(tenantId);
  const [catalogue, lastSales, config, buyList] = await Promise.all([
    getStockCatalogue(tenantId, { canViewCosts }),
    db.salesHistory.groupBy({ by: ["productId"], _max: { date: true } }),
    db.tenantConfig.findFirst({ select: { deadStockWindowDays: true } }),
    getBuyList(tenantId, { canViewCosts }),
  ]);

  // Same scope as the tiles: what the shop still sells.
  const rows = catalogue.filter((r) => r.buyable);
  const lastSale = new Map(lastSales.map((s) => [s.productId, s._max.date]));
  const deadWindowDays = config?.deadStockWindowDays ?? DEFAULT_DEAD_STOCK_DAYS;
  const deadCutoff = Date.now() - deadWindowDays * DAY_MS;

  const stockout: CatalogueRow[] = [];
  const dead: CatalogueRow[] = [];
  let healthy = 0;
  for (const row of rows) {
    const pile = pileFor(
      { onHandUnits: row.onHandUnits, lastSaleAt: lastSale.get(row.productId) ?? null },
      deadCutoff
    );
    if (pile === "stockout") stockout.push(row);
    else if (pile === "dead") dead.push(row);
    else healthy += 1;
  }

  // On the way is orthogonal to the piles — a product can be out of stock AND
  // have a delivery coming, and both facts matter.
  const onway = rows
    .filter((r) => r.onOrderUnits > 0)
    .sort((a, b) => (a.expectedArrivalAt?.getTime() ?? Infinity) - (b.expectedArrivalAt?.getTime() ?? Infinity));

  const byId = new Map(rows.map((r) => [r.productId, r]));
  const reorder = (buyList?.rows ?? [])
    .map((r) => byId.get(r.productId))
    .filter((r): r is CatalogueRow => r != null);

  const piles: Record<DashboardTab, CatalogueRow[]> = {
    stockout: stockout.sort((a, b) => b.runRate - a.runRate),
    reorder,
    onway,
    dead: dead.sort((a, b) => (b.moneyAtRestKes ?? 0) - (a.moneyAtRestKes ?? 0)),
    all: [...rows].sort((a, b) => b.revenue30dKes - a.revenue30dKes),
  };

  const counts = {} as Record<DashboardTab, number>;
  const capped = {} as Record<DashboardTab, boolean>;
  const capped_rows = {} as Record<DashboardTab, CatalogueRow[]>;
  for (const key of Object.keys(piles) as DashboardTab[]) {
    counts[key] = piles[key].length;
    capped[key] = piles[key].length > limit;
    capped_rows[key] = piles[key].slice(0, limit);
  }

  // The export takes the whole dead pile, not the capped page, and adds the
  // last-sale facts the file names. On-hand, cost and price all come from the
  // catalogue row, so the numbers match the tab; last sale is the map already
  // fetched for the piling. Ranked by frozen cash — cost when the caller can see
  // it, retail otherwise — so a money-blind file still leads with the biggest
  // pile of unsold stock rather than sorting on a redacted null.
  const now = Date.now();
  const deadStockExport: DeadStockExportRow[] = piles.dead
    .map((row) => {
      const last = lastSale.get(row.productId) ?? null;
      return {
        sku: row.sku,
        title: row.title,
        vendor: row.vendor,
        onHandUnits: row.onHandUnits,
        lastSaleAt: last,
        daysSinceLastSale: last ? Math.floor((now - last.getTime()) / DAY_MS) : null,
        valueAtCostKes: row.moneyAtRestKes,
        valueAtRetailKes: row.priceKes * Math.max(0, row.onHandUnits),
      };
    })
    .sort(
      (a, b) =>
        (canViewCosts ? (b.valueAtCostKes ?? 0) - (a.valueAtCostKes ?? 0) : 0) ||
        b.valueAtRetailKes - a.valueAtRetailKes
    );

  const criticalRows = (buyList?.rows ?? []).filter((r) => r.urgency === "critical");

  return {
    counts,
    healthy,
    rows: capped_rows,
    deadWindowDays,
    // Summed over every dead row, not the page of them the table shows.
    deadCostKes: canViewCosts
      ? dead.reduce((sum, r) => sum + (r.moneyAtRestKes ?? 0), 0)
      : null,
    criticalCount: criticalRows.length,
    // Summed from the same rows that produced the count, so the two can never
    // describe different sets of lines.
    criticalCostKes: canViewCosts
      ? criticalRows.reduce((sum, r) => sum + (r.lineTotalKes ?? 0), 0)
      : null,
    capped,
    deadStockExport,
  };
}
