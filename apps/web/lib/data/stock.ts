import { prismaForTenant, roleOf, type LocationRole } from "@wezesha/db";
import { leadDaysFor, urgencyFromDays, type AbcCategory } from "@wezesha/forecast";
import { getCatalogueMetrics } from "@/lib/metrics";
import { buildFacetItems, type FacetItem, type FacetSourceRow } from "@/lib/facets";
import {
  coverVerdict,
  marginPct,
  resolveCost,
  suspectCostPresent,
  type CostSource,
  type VerdictKind,
} from "@/lib/cost";

/**
 * Stock-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout.
 *
 * Every number flows from the shared metric engine (lib/metrics):
 *   - Sellable on-hand = Product.currentStock (the Sells-only rollup) — the ONE
 *     source. Warehouse (Holds) stock is reported separately, never as sellable
 *     cover; en-route / ignore locations never count as sellable on-hand.
 *   - Run rate = the blended engine rate; cover is recomputed LIVE from current
 *     stock at that rate (not read from a stale forecast snapshot).
 * Each catalogue row also carries its facet projection (lib/facets) so the
 * filter/sort bar derives its options from the real catalogue.
 *
 * Cost fields are redacted here, not at render: both getters take an explicit
 * `canViewCosts` and return null for unit costs, stock-value-at-cost, and
 * money-at-rest when it is false, so a money-blind member's payload never
 * carries the numbers. Selling price is a sales figure and stays visible.
 */

/** Run rate at or below this is "no velocity": cover is meaningless, so it reads
 *  "—" rather than the engine's 999 sentinel. */
const NO_RATE_EPSILON = 0.0001;

export type CatalogueRow = {
  productId: string;
  sku: string;
  title: string;
  vendor: string | null;
  /** Sellable on-hand — Product.currentStock (Sells-only rollup). */
  onHandUnits: number;
  /** On-hand held in warehouses (Holds) — distributable, not sellable. */
  warehouseUnits: number;
  /** Cover (days left), recomputed live from current stock; null when there is
   *  no run rate to divide by. */
  daysCover: number | null;
  /** Live urgency from cover + run rate; null when there is no run rate. */
  urgency: string | null;
  priceKes: number;
  /** Blended all-channel run rate (units/day). */
  runRate: number;
  /** Revenue (KES) over the trailing 30 days — the revenue-per-product metric. */
  revenue30dKes: number;
  /** Null when the caller can't view costs. */
  costKes: number | null;
  /** (sellable + warehouse) on-hand x unit cost — owned inventory at cost.
   *  Null when the caller can't view costs. */
  stockValueKes: number | null;
  /** cost x sellable on-hand — capital tied up in the shelf (also the per-row
   *  "cash tied up" column). Null when the caller can't view costs. */
  moneyAtRestKes: number | null;
  /** ABC class; null = too-new / no sales ("—"). */
  abc: AbcCategory | null;
  // ── Cost chain + inventory-truth (this slice) ──────────────────────────────
  /** Owner-defined category (the Category facet); null = uncategorised. */
  customCategory: string | null;
  /** Resolved cost source with zero-as-missing applied — always shown (a source
   *  label / data-quality signal, not a KES amount). */
  costSource: CostSource;
  /** Owner-marked tester/display/damaged: stays in the catalogue, out of
   *  sellable cover / money band / buy list. */
  notForSale: boolean;
  /** Resolved lead time (product override → supplier → 30d default) — feeds the
   *  cover verdict and the "below lead" revenue-at-risk tile. */
  leadDays: number;
  /** Cover verdict pill; null for a not-for-sale row (no sellable judgement). */
  verdict: VerdictKind | null;
  /** Margin % of price (loud red when negative). Null when there's no price, or
   *  the caller can't view costs. */
  marginPct: number | null;
  /** Cost is missing/zero (held off the buy list). */
  missingCost: boolean;
  /** Cost is present but >= price (suspect). */
  suspectCost: boolean;
  /** Held off the buy list (engine's plannable rule). */
  heldOffBuyList: boolean;
  /** A synced cost jumped sharply — the attention signal (signed %); null = no
   *  active alert. Not a KES amount, so shown regardless of cost visibility. */
  costMovedPct: number | null;
  costMovedAt: Date | null;
  /** This product projected onto every metadata facet (brand, type, category,
   *  supplier, speed band, ABC, health) — the input the filter bar derives from. */
  facet: FacetItem;
};

export async function getStockCatalogue(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<CatalogueRow[]> {
  const db = prismaForTenant(tenantId);
  const [products, levels, locations, metrics] = await Promise.all([
    db.product.findMany({
      where: { active: true },
      select: {
        id: true,
        sku: true,
        title: true,
        vendor: true,
        productType: true,
        customCategory: true,
        priceKes: true,
        costKes: true,
        costSource: true,
        notForSale: true,
        costMovedPct: true,
        costMovedAt: true,
        supplierId: true,
        leadTimeDays: true,
        shopifyCreatedAt: true,
        supplier: { select: { name: true, leadTimeAvgDays: true } },
      },
      orderBy: { title: "asc" },
    }),
    db.inventoryLevel.groupBy({ by: ["productId", "locationId"], _sum: { onHand: true } }),
    db.location.findMany({ select: { id: true, locationType: true } }),
    getCatalogueMetrics(tenantId),
  ]);

  const roleByLocation = new Map(locations.map((l) => [l.id, roleOf(l)]));
  const holds = new Map<string, number>();
  for (const lvl of levels) {
    if (roleByLocation.get(lvl.locationId) === "holds") {
      holds.set(lvl.productId, (holds.get(lvl.productId) ?? 0) + (lvl._sum.onHand ?? 0));
    }
  }

  // Facet projection for the filter bar: derived from the same metric numbers.
  const facetRows: FacetSourceRow[] = products.map((p) => {
    const m = metrics.get(p.id);
    return {
      productId: p.id,
      vendor: p.vendor,
      productType: p.productType,
      customCategory: p.customCategory,
      sku: p.sku,
      costKes: p.costKes,
      supplierId: p.supplierId,
      supplierName: p.supplier?.name ?? null,
      leadDays: leadDaysFor(p, p.supplier),
      sellableOnHand: m?.sellableOnHand ?? 0,
      runRate: m?.runRate ?? 0,
      abc: m?.abc ?? null,
      createdAt: p.shopifyCreatedAt,
    };
  });
  const facetById = new Map(buildFacetItems(facetRows).map((f) => [f.productId, f]));

  return products.map((p) => {
    const m = metrics.get(p.id);
    const sellable = m?.sellableOnHand ?? 0;
    const warehouse = holds.get(p.id) ?? 0;
    const rate = m?.runRate ?? 0;
    const hasRate = rate > NO_RATE_EPSILON;
    const cover = m?.coverDays ?? null;
    const daysCover = hasRate ? cover : null;

    // Resolve the cost once (zero-as-missing, suspect, held-off). A not-for-sale
    // row is out of sellable stock, so its cover verdict and cost/supplier health
    // flags go quiet (spec §2).
    const cost = resolveCost({ costKes: p.costKes, costSource: p.costSource, priceKes: p.priceKes });
    const leadDays = leadDaysFor(p, p.supplier) ?? 30;

    return {
      productId: p.id,
      sku: p.sku,
      title: p.title,
      vendor: p.vendor,
      onHandUnits: sellable,
      warehouseUnits: warehouse,
      daysCover: p.notForSale ? null : daysCover,
      urgency: hasRate && sellable > 0 && cover != null ? urgencyFromDays(cover, rate) : null,
      priceKes: p.priceKes,
      runRate: rate,
      revenue30dKes: m?.revenueKes[30] ?? 0,
      costKes: canViewCosts ? p.costKes : null,
      stockValueKes: canViewCosts ? (sellable + warehouse) * p.costKes : null,
      moneyAtRestKes: canViewCosts ? (m?.moneyAtRestKes ?? 0) : null,
      abc: m?.abc ?? null,
      customCategory: p.customCategory,
      costSource: cost.source,
      notForSale: p.notForSale,
      leadDays,
      verdict: p.notForSale ? null : coverVerdict(sellable, daysCover, leadDays),
      marginPct: canViewCosts && cost.costKes > 0 ? marginPct(cost.costKes, p.priceKes) : null,
      missingCost: !p.notForSale && cost.suspectReason === "missing",
      suspectCost: !p.notForSale && suspectCostPresent({ costKes: p.costKes, costSource: p.costSource, priceKes: p.priceKes }),
      heldOffBuyList: cost.heldOffBuyList,
      costMovedPct: p.notForSale ? null : p.costMovedPct,
      costMovedAt: p.notForSale ? null : p.costMovedAt,
      facet: facetById.get(p.id)!,
    };
  });
}

export type CategoryUsage = { name: string; count: number };

/** Owner-defined categories in use (distinct Product.customCategory) with their
 *  product counts — the source for the Manage-categories panel and the row
 *  editor's category picker. Categories live on the product, so this is derived,
 *  never a table. */
export async function getCustomCategories(tenantId: string): Promise<CategoryUsage[]> {
  const db = prismaForTenant(tenantId);
  const groups = await db.product.groupBy({
    by: ["customCategory"],
    where: { active: true, customCategory: { not: null } },
    _count: { _all: true },
  });
  return groups
    .filter((g): g is typeof g & { customCategory: string } => g.customCategory != null)
    .map((g) => ({ name: g.customCategory, count: g._count._all }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
 * derived by allocating the product's BLENDED run rate (the shared engine
 * number, not a stale cache) across selling branches in proportion to the stock
 * each holds. For a single-selling-branch shop this is exact; for multi-branch
 * it degrades gracefully until attribution lands.
 */
export async function getStockByLocation(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<LocationStock[]> {
  const db = prismaForTenant(tenantId);
  const [locations, metrics] = await Promise.all([
    db.location.findMany({
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      include: {
        inventoryLevels: {
          include: { product: { select: { id: true, sku: true, title: true, costKes: true } } },
        },
      },
    }),
    getCatalogueMetrics(tenantId),
  ]);

  const rateFor = (productId: string) => metrics.get(productId)?.runRate ?? 0;

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
          const rate = rateFor(level.product.id);
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
