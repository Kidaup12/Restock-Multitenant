import { prismaForTenant, roleOf, type LocationRole } from "@wezesha/db";

/**
 * Stock-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout. On-hand is rolled up BY LOCATION ROLE (spec §1):
 *   - sellable on-hand = Sells locations only
 *   - warehouse (Holds) stock is reported separately, not as sellable cover
 *   - en-route / ignore locations never count as sellable on-hand
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
  /** Sellable on-hand: summed InventoryLevel.onHand at SELLS locations only. */
  onHandUnits: number;
  /** On-hand held in warehouses (Holds) — distributable, not sellable. */
  warehouseUnits: number;
  /** daysUntilStockout from the latest forecast run; null before the first run. */
  daysCover: number | null;
  urgency: string | null;
  priceKes: number;
  /** Null when the caller can't view costs. */
  costKes: number | null;
  /** (sellable + warehouse) on-hand x unit cost — owned inventory at cost.
   *  Null when the caller can't view costs. */
  stockValueKes: number | null;
};

export async function getStockCatalogue(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<CatalogueRow[]> {
  const db = prismaForTenant(tenantId);
  const [products, levels, locations, latest] = await Promise.all([
    db.product.findMany({
      where: { active: true },
      select: { id: true, sku: true, title: true, vendor: true, priceKes: true, costKes: true },
      orderBy: { title: "asc" },
    }),
    db.inventoryLevel.groupBy({ by: ["productId", "locationId"], _sum: { onHand: true } }),
    db.location.findMany({ select: { id: true, locationType: true } }),
    db.prediction.findFirst({ orderBy: { runDate: "desc" }, select: { forecastRunId: true } }),
  ]);

  const roleByLocation = new Map(locations.map((l) => [l.id, roleOf(l)]));
  const sells = new Map<string, number>();
  const holds = new Map<string, number>();
  for (const lvl of levels) {
    const units = lvl._sum.onHand ?? 0;
    const role = roleByLocation.get(lvl.locationId);
    if (role === "sells") sells.set(lvl.productId, (sells.get(lvl.productId) ?? 0) + units);
    else if (role === "holds") holds.set(lvl.productId, (holds.get(lvl.productId) ?? 0) + units);
  }

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
    const sellable = sells.get(p.id) ?? 0;
    const warehouse = holds.get(p.id) ?? 0;
    const prediction = predictionByProduct.get(p.id);
    return {
      productId: p.id,
      sku: p.sku,
      title: p.title,
      vendor: p.vendor,
      onHandUnits: sellable,
      warehouseUnits: warehouse,
      daysCover: prediction?.daysUntilStockout ?? null,
      urgency: prediction?.urgency ?? null,
      priceKes: p.priceKes,
      costKes: canViewCosts ? p.costKes : null,
      stockValueKes: canViewCosts ? (sellable + warehouse) * p.costKes : null,
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
  /** Days of cover for this SKU AT THIS BRANCH; null when there's no run rate
   *  to judge against or the location doesn't sell (Holds/En-route/Ignore). */
  daysCover: number | null;
  /** Negative on-hand — oversold; flagged, never hidden. */
  oversold: boolean;
};

export type LocationStock = {
  locationId: string;
  name: string;
  locationType: string | null;
  /** Calculation role of this location. */
  role: LocationRole;
  isPrimary: boolean;
  /** Cover dots only make sense for selling locations. */
  showCover: boolean;
  /** SKUs with a non-zero position at this location. */
  skuCount: number;
  unitsOnHand: number;
  /** Null when the caller can't view costs. */
  stockValueKes: number | null;
  lines: LocationLine[];
};

/**
 * Per-branch run rate is not yet attributed from history (needs per-branch
 * SalesHistory.locationId / POS mapping), so cover at a selling branch is
 * derived by allocating the product's daily rate across selling branches in
 * proportion to the stock each holds. For a single-selling-branch shop this is
 * exact; for multi-branch it degrades gracefully until attribution lands.
 */
export async function getStockByLocation(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<LocationStock[]> {
  const db = prismaForTenant(tenantId);
  const [locations, products] = await Promise.all([
    db.location.findMany({
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      include: {
        inventoryLevels: {
          include: { product: { select: { id: true, sku: true, title: true, costKes: true, dailySalesRate: true } } },
        },
      },
    }),
    db.product.findMany({ select: { id: true, dailySalesRate: true } }),
  ]);

  const rateByProduct = new Map(products.map((p) => [p.id, p.dailySalesRate]));

  // Total sellable on-hand per product across all Sells locations — the
  // denominator for the stock-share allocation of run rate.
  const sellsTotal = new Map<string, number>();
  for (const location of locations) {
    if (roleOf(location) !== "sells") continue;
    for (const lvl of location.inventoryLevels) {
      if (lvl.onHand > 0) sellsTotal.set(lvl.productId, (sellsTotal.get(lvl.productId) ?? 0) + lvl.onHand);
    }
  }

  return locations.map((location) => {
    const role = roleOf(location);
    const showCover = role === "sells";
    const held = location.inventoryLevels
      .filter((level) => level.onHand !== 0) // keep oversold (negative), drop only true zeros
      .sort((a, b) => b.onHand - a.onHand);

    return {
      locationId: location.id,
      name: location.name,
      locationType: location.locationType,
      role,
      isPrimary: location.isPrimary,
      showCover,
      skuCount: held.length,
      unitsOnHand: held.reduce((s, l) => s + l.onHand, 0),
      stockValueKes: canViewCosts
        ? held.reduce((s, l) => s + l.onHand * l.product.costKes, 0)
        : null,
      lines: held.map((level) => {
        const oversold = level.onHand < 0;
        let daysCover: number | null = null;
        if (showCover) {
          const total = sellsTotal.get(level.product.id) ?? 0;
          const rate = rateByProduct.get(level.product.id) ?? 0;
          const branchRate = total > 0 ? rate * (Math.max(level.onHand, 0) / total) : 0;
          daysCover = branchRate > 0 ? Math.floor(level.onHand / branchRate) : null;
        }
        return {
          productId: level.product.id,
          sku: level.product.sku,
          title: level.product.title,
          onHand: level.onHand,
          valueKes: canViewCosts ? level.onHand * level.product.costKes : null,
          daysCover,
          oversold,
        };
      }),
    };
  });
}
