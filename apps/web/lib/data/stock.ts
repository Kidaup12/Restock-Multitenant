import {
  OUTSTANDING_PO_STATUSES,
  earliestEtaByProduct,
  effectiveOnOrder,
  heldReason,
  isBuyable,
  LIFECYCLE_LABELS,
  outstandingByProduct,
  prismaForTenant,
  productLifecycle,
  roleOf,
  sellableUnits,
  type LocationRole,
  type ProductLifecycle,
} from "@wezesha/db";
import { ASSUMED_LEAD_DAYS, leadDaysFor, urgencyFromDays, type AbcCategory } from "@wezesha/forecast";
import { getCatalogueMetrics } from "@/lib/metrics";
import { buildFacetItems, type FacetItem, type FacetSourceRow } from "@/lib/facets";
import {
  buildAggregates,
  pageBounds,
  parseCatalogueQuery,
  selectRows,
  PAGE_SIZE,
  type CatalogueAggregates,
  type CatalogueQuery,
  type RawSearchParams,
} from "@/lib/catalogue";
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
 * The catalogue loads EVERY product, including the ones the shop has stopped
 * selling. Archiving a SKU in Shopify must not make it vanish with no way back —
 * the owner still has stock and cash in it. Each row carries its lifecycle and,
 * when it is off the buy list, the reason in plain words; the screen scopes the
 * default view to what is still selling. Buy-list exclusion is a separate
 * concern and stays with BUYABLE_PRODUCT_WHERE where the plan is built.
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
  /** "Shade 03 / 50ml" — null on a single-variant product. Sibling variants share
   *  one title, so this is what tells six rows apart. */
  variantTitle: string | null;
  /** Grouping key sibling variants share; not an identity. */
  shopifyProductId: string | null;
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
  /** Resolved cost source with zero-as-missing applied. Null for a money-blind
   *  caller: "there is a typed cost" is a cost fact even though it carries no
   *  figure. */
  costSource: CostSource | null;
  /** Owner-marked tester/display/damaged: stays in the catalogue, out of
   *  sellable cover / money band / buy list. */
  notForSale: boolean;
  // ── Lifecycle (packages/db/product-lifecycle — one definition everywhere) ──
  /** Where this SKU stands with the shop: active / unlisted / draft / archived /
   *  removed / not_for_sale / deactivated. */
  lifecycle: ProductLifecycle;
  /** The lifecycle's display label, resolved here so the client table never
   *  imports the db package — that pulls the Prisma client into the browser
   *  bundle and the whole table stops hydrating. */
  lifecycleLabel: string;
  /** Whether the buy list would consider it — active and unlisted only. */
  buyable: boolean;
  /** Why it is off the buy list, in the owner's words; null when it is on it. */
  lifecycleReason: string | null;
  /** Units already ordered and not yet received — an empty shelf with stock en
   *  route is not a re-order. */
  onOrderUnits: number;
  /** When that inbound stock is due; null when nothing is on order or the
   *  supplier gave no date. */
  expectedArrivalAt: Date | null;
  /** Last per-SKU sync failure; null = the last sync was clean. */
  syncError: string | null;
  syncErrorAt: Date | null;
  /** Resolved lead time (product override → supplier → ASSUMED_LEAD_DAYS) —
   *  feeds the cover verdict and the "below lead" revenue-at-risk tile. */
  leadDays: number;
  /** Cover verdict pill; null for a not-for-sale row (no sellable judgement). */
  verdict: VerdictKind | null;
  /** Margin % of price (loud red when negative). Null when there's no price, or
   *  the caller can't view costs. */
  marginPct: number | null;
  // The next four are cost facts wearing a boolean. "Sold at or below cost",
  // "has no cost", "its cost jumped" are exactly what money-blindness withholds
  // — the figure is the smaller half of the disclosure. All false/null for a
  // money-blind caller, which also keeps them out of the catalogue's health
  // chips (`rowHealthKeys`), where they were filterable by URL.
  /** Cost is missing/zero (held off the buy list). */
  missingCost: boolean;
  /** Cost is present but >= price (suspect). */
  suspectCost: boolean;
  /** Held off the buy list (engine's plannable rule). */
  heldOffBuyList: boolean;
  /** A synced cost jumped sharply — the attention signal (signed %); null = no
   *  active alert. */
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
  const [products, levels, locations, metrics, poLines] = await Promise.all([
    db.product.findMany({
      select: {
        id: true,
        sku: true,
        title: true,
        variantTitle: true,
        shopifyProductId: true,
        vendor: true,
        productType: true,
        customCategory: true,
        priceKes: true,
        costKes: true,
        costSource: true,
        notForSale: true,
        active: true,
        shopifyStatus: true,
        publishedAt: true,
        missingFromShopifyAt: true,
        syncError: true,
        syncErrorAt: true,
        onOrder: true,
        expectedArrivalAt: true,
        costMovedPct: true,
        costMovedAt: true,
        supplierId: true,
        leadTimeDays: true,
        shopifyCreatedAt: true,
        supplier: { select: { name: true, leadTimeAvgDays: true } },
      },
      // Sibling variants share a title, so the variant label is the tie-break —
      // shades land in their own order rather than shuffled.
      orderBy: [{ title: "asc" }, { variantTitle: "asc" }],
    }),
    // findMany + fold rather than groupBy/_sum: `available` is nullable and SQL
    // SUM skips NULLs, so two independent sums could not be reconciled per row
    // into "available, falling back to on-hand". The unique key is already
    // (locationId, productId), so the groupBy was collapsing nothing anyway.
    db.inventoryLevel.findMany({
      select: { productId: true, locationId: true, available: true, onHand: true },
    }),
    db.location.findMany({ select: { id: true, locationType: true } }),
    getCatalogueMetrics(tenantId),
    // Stock we ordered ourselves: the units the catalogue must count as inbound,
    // and the only place its ETA comes from.
    db.purchaseOrderLine.findMany({
      where: {
        purchaseOrder: { status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null },
      },
      select: {
        productId: true,
        quantity: true,
        receivedQty: true,
        purchaseOrder: { select: { expectedAt: true } },
      },
    }),
  ]);

  const outstandingPoUnits = outstandingByProduct(poLines);
  const etaByProduct = earliestEtaByProduct(poLines);
  const roleByLocation = new Map(locations.map((l) => [l.id, roleOf(l)]));
  const holds = new Map<string, number>();
  for (const lvl of levels) {
    if (roleByLocation.get(lvl.locationId) === "holds") {
      // What a warehouse can actually send, not what is standing in it: units
      // already promised to an order cannot be moved.
      holds.set(lvl.productId, (holds.get(lvl.productId) ?? 0) + sellableUnits(lvl));
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
  // `missing_cost` is a health flag derived from the cost itself, and the facet
  // feeds the catalogue's filter chips — leaving it in hands a money-blind
  // member a chip that selects exactly the products with no cost. The other
  // flags (supplier, SKU, negative, new, dead) carry no cost fact.
  const facetById = new Map(
    buildFacetItems(facetRows).map((f) => [
      f.productId,
      canViewCosts ? f : { ...f, health: f.health.filter((h) => h !== "missing_cost") },
    ])
  );

  return products.map((p) => {
    const m = metrics.get(p.id);
    const sellable = m?.sellableOnHand ?? 0;
    const warehouse = holds.get(p.id) ?? 0;
    const rate = m?.runRate ?? 0;
    const hasRate = rate > NO_RATE_EPSILON;
    const cover = m?.coverDays ?? null;
    const daysCover = hasRate ? cover : null;

    // Resolve the cost once (zero-as-missing, suspect, held-off). A row the shop
    // no longer sells — not-for-sale, archived, removed — is out of sellable
    // stock, so its cover verdict and cost/supplier health flags go quiet: there
    // is nothing to re-order, and the reason it is held reads instead.
    const cost = resolveCost({ costKes: p.costKes, costSource: p.costSource, priceKes: p.priceKes });
    const leadDays = leadDaysFor(p, p.supplier) ?? ASSUMED_LEAD_DAYS;
    const buyable = isBuyable(p);
    const lifecycle = productLifecycle(p);

    return {
      productId: p.id,
      sku: p.sku,
      title: p.title,
      variantTitle: p.variantTitle,
      shopifyProductId: p.shopifyProductId,
      vendor: p.vendor,
      onHandUnits: sellable,
      warehouseUnits: warehouse,
      daysCover: buyable ? daysCover : null,
      urgency: buyable && hasRate && sellable > 0 && cover != null ? urgencyFromDays(cover, rate) : null,
      priceKes: p.priceKes,
      runRate: rate,
      revenue30dKes: m?.revenueKes[30] ?? 0,
      costKes: canViewCosts ? p.costKes : null,
      stockValueKes: canViewCosts ? (sellable + warehouse) * p.costKes : null,
      moneyAtRestKes: canViewCosts ? (m?.moneyAtRestKes ?? 0) : null,
      abc: m?.abc ?? null,
      customCategory: p.customCategory,
      costSource: canViewCosts ? cost.source : null,
      notForSale: p.notForSale,
      lifecycle,
      lifecycleLabel: LIFECYCLE_LABELS[lifecycle],
      buyable,
      lifecycleReason: heldReason(p),
      onOrderUnits: effectiveOnOrder(p.onOrder, outstandingPoUnits.get(p.id) ?? 0),
      expectedArrivalAt: etaByProduct.get(p.id) ?? null,
      syncError: p.syncError,
      syncErrorAt: p.syncErrorAt,
      leadDays,
      verdict: buyable ? coverVerdict(sellable, daysCover, leadDays) : null,
      marginPct: canViewCosts && cost.costKes > 0 ? marginPct(cost.costKes, p.priceKes) : null,
      missingCost: canViewCosts && buyable && cost.suspectReason === "missing",
      suspectCost:
        canViewCosts &&
        buyable &&
        suspectCostPresent({ costKes: p.costKes, costSource: p.costSource, priceKes: p.priceKes }),
      heldOffBuyList: canViewCosts && cost.heldOffBuyList,
      // Cost-blind to the flag as well as the figure. The catalogue derives a
      // "cost moved" facet from these, and a chip that filters to exactly the
      // products whose buying price jumped names them — the percentage is the
      // smaller half of that disclosure.
      costMovedPct: buyable && canViewCosts ? p.costMovedPct : null,
      costMovedAt: buyable && canViewCosts ? p.costMovedAt : null,
      facet: facetById.get(p.id)!,
    };
  });
}

/** The catalogue screen's payload: the readings across the whole catalogue, and
 *  the one page of rows the table renders. */
export type CatalogueScreen = {
  rows: CatalogueRow[];
  aggregates: CatalogueAggregates;
  pageCount: number;
  /** Clamped page actually returned — the requested one may be past the end. */
  page: number;
  /** 1-based index of the first returned row, for "showing 51–100 of 312". */
  from: number;
  /** Whether the catalogue holds any product at all, which is a different empty
   *  state from "no row matches these filters". */
  empty: boolean;
};

/**
 * Everything the Stock screen needs, from ONE catalogue load.
 *
 * The whole catalogue still has to be read: ABC is a percentile ranking across
 * it, duplicate-SKU detection needs every SKU, and each chip counts what the
 * reader has not filtered to yet. What changed is what travels — the aggregates
 * plus fifty rows, instead of every row the shop owns. At 400 products that is
 * the difference between a 633 KB document and one that stops growing with the
 * catalogue.
 *
 * Filtering and sorting happen here, through the same predicates the table uses
 * (lib/catalogue), so a chip's count and the rows it filters to cannot drift.
 */
export async function getCatalogueScreen(
  tenantId: string,
  { canViewCosts, query }: { canViewCosts: boolean; query: CatalogueQuery }
): Promise<CatalogueScreen> {
  const all = await getStockCatalogue(tenantId, { canViewCosts });
  const matched = selectRows(all, query);
  const { pageCount, current, start } = pageBounds(matched.length, query.page);

  return {
    rows: matched.slice(start, start + PAGE_SIZE),
    aggregates: buildAggregates(all, query, matched, { canViewCosts }),
    pageCount,
    page: current,
    from: start + 1,
    empty: all.length === 0,
  };
}

export type CategoryUsage = { name: string; count: number };

/** Owner-defined categories in use (distinct Product.customCategory) with their
 *  product counts — the source for the Manage-categories panel and the row
 *  editor's category picker. Categories live on the product, so this is derived,
 *  never a table. Counted over the whole catalogue so the number matches the rows
 *  the category actually filters to, archived ones included. */
export async function getCustomCategories(tenantId: string): Promise<CategoryUsage[]> {
  const db = prismaForTenant(tenantId);
  const groups = await db.product.groupBy({
    by: ["customCategory"],
    where: { customCategory: { not: null } },
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
  /** Days of cover for this SKU ACROSS THE SHOP's selling locations — not this
   *  branch alone, which needs sales attributed per location to be knowable.
   *  Null when there's no run rate to judge against or the location doesn't sell
   *  (Holds/En-route/Ignore). */
  daysCover: number | null;
  /** Negative on-hand — oversold; flagged, never hidden. */
  oversold: boolean;
  /** Units en route to THE SHOP, not to this branch — the same shop-wide figure
   *  the catalogue shows, and the column says so. There is no destination branch
   *  to read: Product.onOrder rolls up en-route stock and Shopify's incoming
   *  across the shop, and a purchase order names a supplier, not a branch. Named
   *  for the shared rule (effectiveOnOrder); it renders as "En route", because
   *  most of what it counts is already moving rather than merely ordered. */
  onOrderUnits: number;
  /** When that stock is due; null when nothing is en route or the supplier gave
   *  no date. */
  expectedArrivalAt: Date | null;
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
  const [locations, metrics, poLines] = await Promise.all([
    db.location.findMany({
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      include: {
        inventoryLevels: {
          include: {
            product: { select: { id: true, sku: true, title: true, costKes: true, onOrder: true } },
          },
        },
      },
    }),
    getCatalogueMetrics(tenantId),
    // Stock we ordered ourselves — half of the inbound rule, and the only place
    // an arrival date comes from.
    db.purchaseOrderLine.findMany({
      where: {
        purchaseOrder: { status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null },
      },
      select: {
        productId: true,
        quantity: true,
        receivedQty: true,
        purchaseOrder: { select: { expectedAt: true } },
      },
    }),
  ]);

  const outstandingPoUnits = outstandingByProduct(poLines);
  const etaByProduct = earliestEtaByProduct(poLines);

  const rateFor = (productId: string) => metrics.get(productId)?.runRate ?? 0;

  // Total sellable on-hand per product across all Sells locations — the
  // denominator for the stock-share allocation of run rate.
  const sellsTotal = new Map<string, number>();
  for (const location of locations) {
    if (roleOf(location) !== "sells") continue;
    for (const lvl of location.inventoryLevels) {
      const lvlUnits = sellableUnits(lvl);
      if (lvlUnits > 0) sellsTotal.set(lvl.productId, (sellsTotal.get(lvl.productId) ?? 0) + lvlUnits);
    }
  }

  return locations.map((location) => {
    const role = roleOf(location);
    const showCover = role === "sells";
    // Sellable units throughout, so this screen reconciles with the catalogue
    // and with cover: a unit already promised to a customer is not stock this
    // branch can sell, and showing it here would put the two screens at odds.
    const held = location.inventoryLevels
      .map((level) => ({ level, units: sellableUnits(level) }))
      .filter(({ units }) => units !== 0) // keep oversold (negative), drop only true zeros
      .sort((a, b) => b.units - a.units);

    return {
      locationId: location.id,
      name: location.name,
      locationType: location.locationType,
      role,
      isPrimary: location.isPrimary,
      showCover,
      skuCount: held.length,
      unitsOnHand: held.reduce((s, { units }) => s + units, 0),
      stockValueKes: canViewCosts
        ? held.reduce((s, { level, units }) => s + units * level.product.costKes, 0)
        : null,
      lines: held.map(({ level, units }) => {
        const oversold = units < 0;
        let daysCover: number | null = null;
        if (showCover) {
          // Cover here is the SHOP's, not this branch's, and the column says so.
          //
          // Two faults, one line. It apportioned the run rate by the branch's
          // share of stock — `rate x units/total` — then divided the branch's
          // units by it, which cancels: every branch showed total/rate whatever
          // it held (55 units and 25 units of the same SKU both read 72999d).
          // And computing cover here at all bypassed the engine's own capped
          // figure, so a genuine but tiny rate printed two centuries of cover
          // where every other screen shows the sentinel-free number.
          //
          // Now it reads the shared metric, like the by-product view does. A
          // real per-branch figure needs sales attributed to the branch, which
          // is what SalesHistory cannot yet do everywhere.
          const rate = rateFor(level.product.id);
          const cover = metrics.get(level.product.id)?.coverDays ?? null;
          daysCover = rate > NO_RATE_EPSILON ? cover : null;
        }
        return {
          productId: level.product.id,
          sku: level.product.sku,
          title: level.product.title,
          onHand: units,
          valueKes: canViewCosts ? units * level.product.costKes : null,
          daysCover,
          oversold,
          // Through the shared rule, so this screen and the catalogue cannot
          // report different inbound for the same product.
          onOrderUnits: effectiveOnOrder(
            level.product.onOrder,
            outstandingPoUnits.get(level.product.id) ?? 0
          ),
          expectedArrivalAt: etaByProduct.get(level.product.id) ?? null,
        };
      }),
    };
  });
}

/** The By-location screen's state. It rides the same `q` and `page` params the
 *  catalogue tab uses: only one of the two tabs is on screen at a time, and the
 *  tab link carries neither, so nobody arrives on page 4 of a list they have not
 *  seen yet. */
/**
 * Sortable columns on Inventory. Same `sort`/`dir` shape the catalogue uses, so
 * a reader who has seen one URL can read the other.
 *
 * The reference build says "Click a column to sort" on this screen and ours had
 * no sorting at all — on a 500-SKU catalogue the only way to find a line was to
 * search for it by name, which assumes you already know what you are looking
 * for. Sorting is how you find what you did NOT know to look for.
 */
export const LOCATION_SORT_KEYS = [
  "title",
  "sku",
  "onHand",
  "daysCover",
  "onOrderUnits",
  "valueKes",
] as const;
export type LocationSortKey = (typeof LOCATION_SORT_KEYS)[number];

export type LocationsQuery = {
  search: string;
  page: number;
  sortKey: LocationSortKey;
  desc: boolean;
};

/** Default order: most stock first. What the screen showed before sorting
 *  existed, so turning this on does not silently rearrange anyone's view. */
const DEFAULT_LOCATION_SORT: LocationSortKey = "onHand";

/**
 * Order two lines by one column.
 *
 * Nulls always sink, in both directions. A line with no cover figure is not
 * "the lowest cover" — it is unknown, and floating it to the top of an ascending
 * sort would put the least informative rows where the most urgent belong.
 */
export function compareLocationLines(
  a: LocationLine,
  b: LocationLine,
  key: LocationSortKey,
  desc: boolean,
): number {
  const dir = desc ? -1 : 1;
  if (key === "title" || key === "sku") {
    return a[key].localeCompare(b[key]) * dir;
  }
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return (av - bv) * dir;
}

export function parseLocationsQuery(params: RawSearchParams): LocationsQuery {
  const q = parseCatalogueQuery(params);
  const raw = params["lsort"];
  const sort = Array.isArray(raw) ? raw[0] : raw;
  const dirRaw = params["ldir"];
  const dir = Array.isArray(dirRaw) ? dirRaw[0] : dirRaw;
  return {
    search: q.search,
    page: q.page,
    // Its own param names: this screen's columns are not the catalogue's, and
    // sharing `sort` would make a link copied between the two silently mean
    // something else. Unknown values fall back rather than throw — a
    // hand-edited URL should show the inventory, not an error.
    sortKey: (LOCATION_SORT_KEYS as readonly string[]).includes(sort ?? "")
      ? (sort as LocationSortKey)
      : DEFAULT_LOCATION_SORT,
    desc: dir === "asc" ? false : true,
  };
}

/** This view's URL. Its own serializer now: Inventory carries a search and a
 *  page and nothing else, and borrowing the catalogue's meant every locations
 *  link spelled a `view` param that only existed to pick a tab. */
export function locationsQueryToSearch(q: LocationsQuery): string {
  const out = new URLSearchParams();
  if (q.search) out.set("q", q.search);
  if (q.page > 0) out.set("page", String(q.page + 1));
  // Only when they differ from the default, so the common URL stays short and
  // a shared link does not pin someone to an order they never chose.
  if (q.sortKey !== DEFAULT_LOCATION_SORT) out.set("lsort", q.sortKey);
  if (!q.desc) out.set("ldir", "asc");
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** The hidden fields the search box carries — minus `q` and `page`, which the
 *  box supplies itself. Nothing else survives on this view, so this is empty
 *  today; it stays so the form cannot silently drop a param added later. */
export function locationsQueryFields(): { name: string; value: string }[] {
  return [];
}

/** Product name and SKU: the only two things the per-location table prints as
 *  text — every other column is a number. Terms are ANDed and matched as
 *  substrings, like the catalogue's box, so a run-together SKU (`LP-250ML`) is
 *  still found by typing `250`. */
export function matchesLocationLine(line: LocationLine, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = `${line.title} ${line.sku}`.toLowerCase();
  return terms.every((t) => text.includes(t));
}

/** One location as this page shows it: the location's own totals, and the slice
 *  of its lines that falls inside the page window. */
export type LocationPageStock = LocationStock & {
  /** Lines here that match the search — `skuCount` still counts them all. */
  matchedLines: number;
  /** 1-based position of the first line shown, within that match. */
  from: number;
};

export type LocationsScreen = {
  locations: LocationPageStock[];
  pageCount: number;
  /** Clamped page actually returned — the requested one may be past the end. */
  page: number;
  /** 1-based first and last line on screen, for "showing 51–100 of 211". */
  from: number;
  to: number;
  /** Lines matching the search across every location — what the pager counts. */
  matched: number;
  /** Lines across every location, before the search. */
  total: number;
  /** Whether the shop has any location at all, which is a different empty state
   *  from "no line matches this text". */
  empty: boolean;
};

/**
 * One page of the By-location screen.
 *
 * The screen is a list of locations, each with its own lines, and the lines are
 * where the weight is: one shop floor can hold 131 of a tenant's 211. So the
 * page window walks the LINES in location order and each location renders the
 * part of the window that falls inside it — a location's lines can straddle a
 * break and its card then appears on both pages, under its own heading.
 *
 * Paging the locations instead would leave that 131-line table whole, which is
 * the thing that needed bounding; a page per location would need a page param
 * per location in the URL. The card's own totals (SKUs, units, value) stay
 * location-wide either way — they describe the location, never the page.
 */
export async function getLocationsScreen(
  tenantId: string,
  { canViewCosts, query }: { canViewCosts: boolean; query: LocationsQuery }
): Promise<LocationsScreen> {
  const locations = await getStockByLocation(tenantId, { canViewCosts });
  const searched = locations.map((location) => ({
    location,
    lines: (query.search
      ? location.lines.filter((line) => matchesLocationLine(line, query.search))
      : [...location.lines]
    ).sort((a, b) => compareLocationLines(a, b, query.sortKey, query.desc)),
  }));

  const total = locations.reduce((sum, l) => sum + l.lines.length, 0);
  const matched = searched.reduce((sum, s) => sum + s.lines.length, 0);
  const { pageCount, current, start } = pageBounds(matched, query.page);
  const end = start + PAGE_SIZE;

  const page: LocationPageStock[] = [];
  let cursor = 0;
  for (const { location, lines } of searched) {
    const first = Math.max(start, cursor);
    const last = Math.min(end, cursor + lines.length);
    if (last > first) {
      page.push({
        ...location,
        lines: lines.slice(first - cursor, last - cursor),
        matchedLines: lines.length,
        from: first - cursor + 1,
      });
    } else if (lines.length === 0 && !query.search && cursor >= start && cursor < end) {
      // A location holding nothing takes up no room in the window, so it is
      // pinned to the page its position falls on — "this branch is empty" is
      // worth reading once, and it used to be on screen every time.
      page.push({ ...location, lines: [], matchedLines: 0, from: 1 });
    }
    cursor += lines.length;
  }

  return {
    locations: page,
    pageCount,
    page: current,
    from: matched === 0 ? 0 : start + 1,
    to: Math.min(end, matched),
    matched,
    total,
    empty: locations.length === 0,
  };
}
