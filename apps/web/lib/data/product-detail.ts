import { LIFECYCLE_LABELS, heldReason, prismaForTenant, productLifecycle } from "@wezesha/db";
import { leadDaysFor } from "@wezesha/forecast";
import { runRate, coverDays, revenueByWindow } from "@/lib/metrics";
import { resolveCost } from "@/lib/cost/resolve";

/**
 * One product, everything about it, on one screen.
 *
 * The catalogue answers "which products need me?"; it could never answer "why
 * is THIS one being asked for?" — the deepest surface was an inline row editor.
 * An owner querying a recommendation had to read the buy list, the stock table
 * and the supplier page and hold the three in their head.
 *
 * Server-only, explicit tenantId, RLS-enforced client. Cost figures are redacted
 * here rather than at render: a money-blind member's payload never carries them.
 */

/** A year of months, so seasonality is visible rather than inferred. */
const HISTORY_MONTHS = 12;

const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export type ProductMonth = {
  key: string;
  label: string;
  units: number;
  /** Null for a money-blind caller. Revenue is a sales figure, so it stays. */
  revenueKes: number;
};

export type ProductDetail = {
  productId: string;
  sku: string;
  title: string;
  variantTitle: string | null;
  vendor: string | null;
  productType: string | null;
  imageUrl: string | null;
  abc: string | null;
  lifecycle: string;
  lifecycleLabel: string;
  /** Why the buy list is holding it back, in the owner's words. Null when it isn't. */
  heldReason: string | null;
  shopifyStatus: string | null;

  onHandUnits: number;
  onOrderUnits: number;
  expectedArrivalLabel: string | null;
  runRatePerDay: number;
  daysCover: number | null;

  priceKes: number;
  /** Null for a money-blind caller. */
  unitCostKes: number | null;
  costSource: string | null;
  stockValueKes: number | null;

  supplierName: string | null;
  supplierLeadDays: number | null;
  supplierMoq: number | null;
  /** The lead time the engine actually used, after the product override. */
  effectiveLeadDays: number | null;

  months: ProductMonth[];
  revenue30dKes: number;

  /** The latest run's view of this product, or null before the first run. */
  prediction: {
    recommendedQty: number;
    urgency: string;
    confidenceWord: string | null;
    reasoning: string;
    daysUntilStockout: number | null;
    runLabel: string;
  } | null;
};

/** Month buckets for the last `HISTORY_MONTHS`, oldest first, zero-filled — a
 *  gap in sales is information, so it must render as a zero and not vanish. */
function emptyMonths(now: Date): Map<string, ProductMonth> {
  const out = new Map<string, ProductMonth>();
  for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    out.set(key, { key, label: monthFormat.format(d), units: 0, revenueKes: 0 });
  }
  return out;
}

export async function getProductDetail(
  tenantId: string,
  productId: string,
  { canViewCosts, now = new Date() }: { canViewCosts: boolean; now?: Date }
): Promise<ProductDetail | null> {
  const db = prismaForTenant(tenantId);

  // Resolved on the tenant client: an id from another workspace comes back null
  // and the page 404s, rather than leaking that it exists somewhere.
  const product = await db.product.findFirst({
    where: { id: productId },
    select: {
      id: true,
      sku: true,
      title: true,
      variantTitle: true,
      vendor: true,
      productType: true,
      imageUrl: true,
      abcCategory: true,
      currentStock: true,
      onOrder: true,
      expectedArrivalAt: true,
      priceKes: true,
      costKes: true,
      costSource: true,
      leadTimeDays: true,
      active: true,
      notForSale: true,
      shopifyStatus: true,
      publishedAt: true,
      missingFromShopifyAt: true,
      supplier: {
        select: { name: true, leadTimeAvgDays: true, leadTimeStdDays: true, moq: true },
      },
    },
  });
  if (!product) return null;

  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1));

  const [sales, latestPrediction] = await Promise.all([
    db.salesHistory.findMany({
      where: { productId, date: { gte: since } },
      select: { date: true, quantity: true, revenueKes: true, channel: true },
      orderBy: { date: "asc" },
    }),
    db.prediction.findFirst({
      where: { productId },
      orderBy: { runDate: "desc" },
      select: {
        recommendedQty: true,
        urgency: true,
        confidenceWord: true,
        reasoning: true,
        daysUntilStockout: true,
        runDate: true,
      },
    }),
  ]);

  const buckets = emptyMonths(now);
  for (const row of sales) {
    const key = `${row.date.getUTCFullYear()}-${String(row.date.getUTCMonth() + 1).padStart(2, "0")}`;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.units += row.quantity;
    bucket.revenueKes += row.revenueKes;
  }

  // The same shared formulas the catalogue and the plan use — a product page
  // that computed its own rate would be a second source for the same number.
  const rate = runRate(sales, now);
  const cover = coverDays(product.currentStock, rate);
  const revenue = revenueByWindow(sales, now);
  const cost = resolveCost({
    costKes: product.costKes,
    costSource: product.costSource,
    priceKes: product.priceKes,
  });
  const lifecycle = productLifecycle(product);

  return {
    productId: product.id,
    sku: product.sku,
    title: product.title,
    variantTitle: product.variantTitle,
    vendor: product.vendor,
    productType: product.productType,
    imageUrl: product.imageUrl,
    abc: product.abcCategory,
    lifecycle,
    lifecycleLabel: LIFECYCLE_LABELS[lifecycle],
    heldReason: heldReason(product),
    shopifyStatus: product.shopifyStatus,

    onHandUnits: product.currentStock,
    onOrderUnits: product.onOrder,
    expectedArrivalLabel: product.expectedArrivalAt ? dayFormat.format(product.expectedArrivalAt) : null,
    runRatePerDay: Math.round(rate * 100) / 100,
    // The engine's no-stockout-in-sight sentinel must never print as a day count.
    daysCover: rate > 0 && cover < 999 ? cover : null,

    priceKes: product.priceKes,
    unitCostKes: canViewCosts ? product.costKes : null,
    // Rendered as the note under the masked figure — "typed" or "missing" tells
    // a money-blind reader whether a cost exists and who set it.
    costSource: canViewCosts ? cost.source : null,
    stockValueKes: canViewCosts ? Math.max(0, product.currentStock) * product.costKes : null,

    supplierName: product.supplier?.name ?? null,
    supplierLeadDays: product.supplier?.leadTimeAvgDays ?? null,
    supplierMoq: product.supplier?.moq ?? null,
    effectiveLeadDays: leadDaysFor(product, product.supplier),

    months: [...buckets.values()].map((m) => ({ ...m, revenueKes: Math.round(m.revenueKes) })),
    revenue30dKes: Math.round(revenue[30] ?? 0),

    prediction: latestPrediction
      ? {
          recommendedQty: Math.round(latestPrediction.recommendedQty),
          urgency: latestPrediction.urgency,
          confidenceWord: latestPrediction.confidenceWord,
          reasoning: latestPrediction.reasoning,
          daysUntilStockout:
            latestPrediction.daysUntilStockout >= 999 ? null : latestPrediction.daysUntilStockout,
          runLabel: dayFormat.format(latestPrediction.runDate),
        }
      : null,
  };
}
