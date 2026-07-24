import { prismaForTenant } from "@wezesha/db";
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
 * Loads active products + 365 days of all-channel sales ONCE, then derives every
 * metric through the pure calc layer. Server-only, RLS-enforced tenant client.
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
  /** Blended all-channel run rate (engine, recency-weighted, stockout-corrected). */
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

  const [products, sales] = await Promise.all([
    db.product.findMany({
      where: { active: true },
      select: {
        id: true,
        currentStock: true,
        costKes: true,
        priceKes: true,
        shopifyCreatedAt: true,
      },
    }),
    db.salesHistory.findMany({
      where: { date: { gte: since } },
      select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
    }),
  ]);

  const historyByProduct = new Map<string, SalesPoint[]>();
  for (const row of sales) {
    let list = historyByProduct.get(row.productId);
    if (!list) historyByProduct.set(row.productId, (list = []));
    list.push(row);
  }

  const abc = abcForCatalogue(
    products.map((p) => ({
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
    const rate = runRate(history, asOf);
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
