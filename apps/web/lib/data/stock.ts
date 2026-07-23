import { prismaForTenant } from "@wezesha/db";

/**
 * Stock-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout. On-hand always derives from InventoryLevel sums — the
 * Product.currentStock cache is for list surfaces that can tolerate staleness.
 *
 * Cost fields are redacted here, not at render: both getters take an explicit
 * `canViewCosts` and return null for unit costs and stock-value-at-cost when
 * it is false, so a money-blind member's payload never carries the numbers.
 * Selling price is a sales figure and stays visible.
 */

export type CatalogueRow = {
  productId: string;
  sku: string;
  title: string;
  vendor: string | null;
  /** Summed InventoryLevel.onHand across every location. */
  onHandUnits: number;
  /** daysUntilStockout from the latest forecast run; null before the first run. */
  daysCover: number | null;
  urgency: string | null;
  priceKes: number;
  /** Null when the caller can't view costs. */
  costKes: number | null;
  /** onHand x unit cost. Null when the caller can't view costs. */
  stockValueKes: number | null;
};

export async function getStockCatalogue(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<CatalogueRow[]> {
  const db = prismaForTenant(tenantId);
  const [products, levels, latest] = await Promise.all([
    db.product.findMany({
      where: { active: true },
      select: { id: true, sku: true, title: true, vendor: true, priceKes: true, costKes: true },
      orderBy: { title: "asc" },
    }),
    db.inventoryLevel.groupBy({ by: ["productId"], _sum: { onHand: true } }),
    db.prediction.findFirst({ orderBy: { runDate: "desc" }, select: { forecastRunId: true } }),
  ]);

  const onHand = new Map(levels.map((l) => [l.productId, l._sum.onHand ?? 0]));
  const predictionByProduct = new Map<string, { daysUntilStockout: number; urgency: string }>();
  if (latest) {
    const predictions = await db.prediction.findMany({
      where: { forecastRunId: latest.forecastRunId },
      select: { productId: true, daysUntilStockout: true, urgency: true },
    });
    for (const p of predictions) {
      predictionByProduct.set(p.productId, {
        daysUntilStockout: p.daysUntilStockout,
        urgency: p.urgency,
      });
    }
  }

  return products.map((p) => {
    const units = onHand.get(p.id) ?? 0;
    const prediction = predictionByProduct.get(p.id);
    return {
      productId: p.id,
      sku: p.sku,
      title: p.title,
      vendor: p.vendor,
      onHandUnits: units,
      daysCover: prediction?.daysUntilStockout ?? null,
      urgency: prediction?.urgency ?? null,
      priceKes: p.priceKes,
      costKes: canViewCosts ? p.costKes : null,
      stockValueKes: canViewCosts ? units * p.costKes : null,
    };
  });
}

export type LocationLine = {
  productId: string;
  sku: string;
  title: string;
  onHand: number;
  /** onHand x unit cost. Null when the caller can't view costs. */
  valueKes: number | null;
};

export type LocationStock = {
  locationId: string;
  name: string;
  locationType: string | null;
  isPrimary: boolean;
  /** SKUs with units at this location. */
  skuCount: number;
  unitsOnHand: number;
  /** Null when the caller can't view costs. */
  stockValueKes: number | null;
  /** Per-product levels, largest holdings first. Zero-stock lines excluded. */
  lines: LocationLine[];
};

export async function getStockByLocation(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<LocationStock[]> {
  const db = prismaForTenant(tenantId);
  const locations = await db.location.findMany({
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    include: {
      inventoryLevels: {
        include: { product: { select: { id: true, sku: true, title: true, costKes: true } } },
      },
    },
  });

  return locations.map((location) => {
    const held = location.inventoryLevels
      .filter((level) => level.onHand > 0)
      .sort((a, b) => b.onHand - a.onHand);

    return {
      locationId: location.id,
      name: location.name,
      locationType: location.locationType,
      isPrimary: location.isPrimary,
      skuCount: held.length,
      unitsOnHand: held.reduce((s, l) => s + l.onHand, 0),
      stockValueKes: canViewCosts
        ? held.reduce((s, l) => s + l.onHand * l.product.costKes, 0)
        : null,
      lines: held.map((level) => ({
        productId: level.product.id,
        sku: level.product.sku,
        title: level.product.title,
        onHand: level.onHand,
        valueKes: canViewCosts ? level.onHand * level.product.costKes : null,
      })),
    };
  });
}
