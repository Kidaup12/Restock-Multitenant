import { prismaForTenant } from "@wezesha/db";

/**
 * Stock-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout. On-hand always derives from InventoryLevel sums — the
 * Product.currentStock cache is for list surfaces that can tolerate staleness.
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
  costKes: number;
  /** onHand x unit cost. */
  stockValueKes: number;
};

export async function getStockCatalogue(tenantId: string): Promise<CatalogueRow[]> {
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
      costKes: p.costKes,
      stockValueKes: units * p.costKes,
    };
  });
}

export type LocationLine = {
  productId: string;
  sku: string;
  title: string;
  onHand: number;
  valueKes: number;
};

export type LocationStock = {
  locationId: string;
  name: string;
  locationType: string | null;
  isPrimary: boolean;
  /** SKUs with units at this location. */
  skuCount: number;
  unitsOnHand: number;
  stockValueKes: number;
  /** Per-product levels, largest holdings first. Zero-stock lines excluded. */
  lines: LocationLine[];
};

export async function getStockByLocation(tenantId: string): Promise<LocationStock[]> {
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
    const lines = location.inventoryLevels
      .filter((level) => level.onHand > 0)
      .map((level) => ({
        productId: level.product.id,
        sku: level.product.sku,
        title: level.product.title,
        onHand: level.onHand,
        valueKes: level.onHand * level.product.costKes,
      }))
      .sort((a, b) => b.onHand - a.onHand);

    return {
      locationId: location.id,
      name: location.name,
      locationType: location.locationType,
      isPrimary: location.isPrimary,
      skuCount: lines.length,
      unitsOnHand: lines.reduce((s, l) => s + l.onHand, 0),
      stockValueKes: lines.reduce((s, l) => s + l.valueKes, 0),
      lines,
    };
  });
}
