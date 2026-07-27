import { isBuyable, prismaForTenant } from "@wezesha/db";
import {
  abcForCatalogue,
  coverDays,
  moneyAtRest,
  revenueByWindow,
  runRate,
  type AbcCategory,
  type MetricWindow,
  type SalesPoint,
} from "./calc";

/**
 * The one place the shared metric set is computed for a tenant's catalogue.
 * Loads the whole catalogue + 365 days of all-channel sales + the days the
 * nightly snapshot found an empty shelf ONCE, then derives every metric through
 * the pure calc layer. Server-only, RLS-enforced tenant client.
 *
 * Products the shop has stopped selling (archived, draft, gone from the store)
 * are loaded too — the stock screen shows them, and it must show real numbers
 * for the stock and cash still sitting in them. They are left OUT of the ABC
 * ranking only, because ABC ranks what the shop sells; including them would push
 * live products down a class.
 *
 * Screens read from this map instead of each running their own aggregate, which
 * is what keeps "one number everywhere" true: on-hand comes from
 * Product.currentStock (the sellable Sells-only rollup) and run rate from the
 * forecast engine — never a second, divergent computation.
 *
 * Cost figures ride along raw (unredacted). The data getters apply the
 * money-blind `canViewCosts` redaction at their boundary, exactly as before —
 * this loader stays a pure numeric source and never decides visibility.
 */

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 365;

export type ProductMetrics = {
  productId: string;
  /** Sellable on-hand — Product.currentStock, the single source. */
  sellableOnHand: number;
  /** Blended all-channel run rate (engine: recency-weighted, spike-damped, over
   *  in-stock days). */
  runRate: number;
  /** Cover (days left), recomputed live from current stock. */
  coverDays: number;
  /** Revenue KES over each contract window (30 / 90 / 365d), all channels. */
  revenueKes: Record<MetricWindow, number>;
  /** cost × sellable on-hand — raw; getters null it for money-blind callers. */
  moneyAtRestKes: number;
  /** ABC class (assignAbc); null = too-new / no sales ("—"). */
  abc: AbcCategory | null;
};

export async function getCatalogueMetrics(
  tenantId: string,
  opts: { asOf?: Date } = {}
): Promise<Map<string, ProductMetrics>> {
  const asOf = opts.asOf ?? new Date();
  const db = prismaForTenant(tenantId);
  const since = new Date(asOf.getTime() - HISTORY_DAYS * DAY_MS);

  const [products, sales, emptyShelfDays, firstSnapshot] = await Promise.all([
    db.product.findMany({
      select: {
        id: true,
        currentStock: true,
        costKes: true,
        priceKes: true,
        shopifyCreatedAt: true,
        active: true,
        notForSale: true,
        shopifyStatus: true,
        publishedAt: true,
        missingFromShopifyAt: true,
      },
    }),
    db.salesHistory.findMany({
      where: { date: { gte: since } },
      select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
    }),
    // Days the nightly snapshot recorded an empty shelf — the in-stock-day
    // denominator behind every run rate. ONE query for the whole catalogue, and
    // only the empty rows travel; the in-stock majority stays in the database.
    db.inventorySnapshot.findMany({
      where: { date: { gte: since }, onHand: { lte: 0 } },
      select: { productId: true, date: true },
    }),
    // How far back that proof reaches. Anything older keeps gap inference rather
    // than being read as "was in stock".
    db.inventorySnapshot.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
  ]);

  const historyByProduct = new Map<string, SalesPoint[]>();
  for (const row of sales) {
    let list = historyByProduct.get(row.productId);
    if (!list) historyByProduct.set(row.productId, (list = []));
    list.push(row);
  }

  const stockoutsByProduct = new Map<string, Date[]>();
  for (const row of emptyShelfDays) {
    let list = stockoutsByProduct.get(row.productId);
    if (!list) stockoutsByProduct.set(row.productId, (list = []));
    list.push(row.date);
  }
  const snapshotsSince = firstSnapshot?.date ?? undefined;

  const abc = abcForCatalogue(
    products
      .filter(isBuyable)
      .map((p) => ({
        id: p.id,
        history: historyByProduct.get(p.id) ?? [],
        priceKes: p.priceKes,
        createdAt: p.shopifyCreatedAt,
      })),
    asOf
  );

  const out = new Map<string, ProductMetrics>();
  for (const p of products) {
    const history = historyByProduct.get(p.id) ?? [];
    const rate = runRate(history, asOf, stockoutsByProduct.get(p.id), snapshotsSince);
    out.set(p.id, {
      productId: p.id,
      sellableOnHand: p.currentStock,
      runRate: rate,
      coverDays: coverDays(p.currentStock, rate),
      revenueKes: revenueByWindow(history, asOf),
      moneyAtRestKes: moneyAtRest(p.costKes, p.currentStock),
      abc: abc.get(p.id) ?? null,
    });
  }
  return out;
}
