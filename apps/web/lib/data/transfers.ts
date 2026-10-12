import {
  BUYABLE_PRODUCT_WHERE,
  isSellable,
  prismaForTenant,
  roleOf,
  sellableUnits,
  type LocationRole,
} from "@wezesha/db";
import {
  sizeTransfers,
  destinationShares,
  clampCoverDays,
  clampWindowDays,
  NO_RATE_EPSILON,
  DEFAULT_COVER_DAYS,
  DEFAULT_WINDOW_DAYS,
  COVER_DAY_CHOICES,
  MIN_COVER_DAYS,
  MAX_COVER_DAYS,
  MIN_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  type DestinationPosition,
  type SizedTransfer,
  type RateBasis,
} from "@wezesha/forecast";
import { getCatalogueMetrics } from "@/lib/metrics";

// The pure sizing engine now lives in @wezesha/forecast so the worker's owner
// report can size the same warehouse→branch moves without importing this
// web-only module. Re-exported here so this file's many consumers (the
// distribution page, actions, tests) keep their existing import paths.
export {
  sizeTransfers,
  destinationShares,
  clampCoverDays,
  clampWindowDays,
  DEFAULT_COVER_DAYS,
  DEFAULT_WINDOW_DAYS,
  COVER_DAY_CHOICES,
  MIN_COVER_DAYS,
  MAX_COVER_DAYS,
  MIN_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  type DestinationPosition,
  type SizedTransfer,
  type RateBasis,
};

/**
 * Transfers — "what to move, from where to where, and why". A distribution plan
 * proposes moving stock out of one holding location so that every selling
 * location ends on the SAME days of cover at its own run rate. Server-only:
 * explicit tenantId, RLS-enforced tenant client throughout.
 *
 * One engine, not a second one:
 *   - Sellable on-hand and the blended run rate come from lib/metrics
 *     (getCatalogueMetrics) — never a fresh sales aggregate here.
 *   - Per-location stock comes from InventoryLevel, the same read the stock
 *     screen does.
 *   - Roles come from @wezesha/db (isSellable / roleOf): a warehouse holds, a
 *     branch sells. No locationType string is compared here.
 *
 * Per-location run rate is an ALLOCATION of the blended rate, never a second
 * rate: `destinationShares` splits it per product, and the split is labelled
 * ("attributed" vs "allocated") so a screen can never present an approximation
 * as measured fact. See that function for the rules.
 *
 * Cost fields are redacted here, not at render: every getter takes an explicit
 * `canViewCosts` and returns null for KES figures when it is false, so a
 * money-blind member's payload never carries the numbers. Row order never
 * depends on a cost, so a redacted payload lists the same lines in the same
 * order as an owner's.
 */

const DAY_MS = 86_400_000;

// ── The proposal (live, unsaved) ─────────────────────────────────────────────

export type TransferLocation = {
  locationId: string;
  name: string;
  role: LocationRole;
  isPrimary: boolean;
  /** Units of any product sitting here — what makes it worth shipping from. */
  unitsOnHand: number;
};

export type TransferLine = {
  productId: string;
  sku: string;
  title: string;
  /** The product's nightly-run class and shop-assigned category — carried onto
   *  the line so the screen can filter and group without a second fetch. */
  abc: string | null;
  category: string | null;
  toLocationId: string;
  toLocationName: string;
  qty: number;
  /** Units of this product at the source before the move. */
  fromOnHand: number;
  toOnHand: number;
  toRunRate: number;
  toDaysCoverBefore: number;
  toDaysCoverAfter: number;
  /** How this line's destination run rate was derived — the honesty label. */
  rateBasis: RateBasis;
  /** qty x unit cost — the value on the move. Null when costs aren't viewable. */
  valueKes: number | null;
};

/** ABC class / category narrowing for the live proposal. Empty = no filter.
 *  Mirrors the plan scope bar's semantics (OR within a dimension) but stays a
 *  plain pair — a proposal line has none of a BuyListRow's other facets, so
 *  pulling in the plan's full ScopeSelection machinery would be a type fit
 *  for a shape this screen doesn't have. */
export type TransferScope = { abc: string[]; category: string[] };

export const EMPTY_TRANSFER_SCOPE: TransferScope = { abc: [], category: [] };

function oneTransferParam(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Rebuild a TransferScope from the URL — `?class=A,B&category=Serums`. */
export function parseTransferScope(params: Record<string, string | string[] | undefined>): TransferScope {
  return { abc: oneTransferParam(params.class), category: oneTransferParam(params.category) };
}

export function transferScopeActive(scope: TransferScope): boolean {
  return scope.abc.length > 0 || scope.category.length > 0;
}

export type TransferScopeOption = { value: string; label: string; count: number };
export type TransferScopeFacets = { abc: TransferScopeOption[]; category: TransferScopeOption[] };

const ABC_ORDER = ["A", "B", "C"];

/** Options (with live counts) for the filter chips, derived from whichever
 *  products are candidates for THIS source — so a chip never offers a class
 *  or category the source holds none of. */
function deriveTransferScopeFacets(
  products: { abcCategory: string | null; customCategory: string | null }[]
): TransferScopeFacets {
  function bucket(valueOf: (p: (typeof products)[number]) => string | null): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of products) {
      const v = valueOf(p);
      if (v == null) continue; // unrated/uncategorised products stay unfiltered, not a "none" bucket
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return counts;
  }
  const abcCounts = bucket((p) => p.abcCategory);
  const categoryCounts = bucket((p) => p.customCategory);
  return {
    abc: [...abcCounts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => ABC_ORDER.indexOf(a.value) - ABC_ORDER.indexOf(b.value)),
    category: [...categoryCounts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export type TransferDestinationSummary = {
  locationId: string;
  name: string;
  units: number;
  skus: number;
  /** Null when the caller can't view costs. */
  valueKes: number | null;
};

/** A selling location the plan could not size for, and why. */
export type SkippedDestination = {
  locationId: string;
  name: string;
  reason: "no-demand-signal";
};

/** Rows on one page of the live proposal. Twenty keeps a page scannable
 *  without the horizontal scrollbar sitting 700 rows below the fold. */
export const PROPOSAL_PAGE_SIZE = 20;

export type DistributionProposal = {
  fromLocationId: string;
  fromLocationName: string;
  coverDays: number;
  windowDays: number;
  /** ONE page of lines, for the table. Stat tiles and destination summaries
   *  are computed from the full (unpaged) list, never this slice — see
   *  `allMatchedLines` for the export, which must carry every matching line. */
  lines: TransferLine[];
  /** Every line matching the current scope, unpaged — what the pick-list
   *  export sends. An export truncated to one page would silently drop the
   *  rest of the plan the person is meant to carry. */
  allMatchedLines: TransferLine[];
  destinations: TransferDestinationSummary[];
  skipped: SkippedDestination[];
  totalUnits: number;
  /** Null when the caller can't view costs. */
  totalValueKes: number | null;
  /** SKUs the plan moves. */
  skuCount: number;
  /** True when at least one line rests on measured per-branch sales. */
  hasAttributedDemand: boolean;
  /** Filter-chip options (with counts) for the products this source can
   *  actually ship — not scoped by the caller's current selection, so a
   *  chosen chip never vanishes once applied. */
  scopeFacets: TransferScopeFacets;
  /** Lines matching the current scope, before paging — what the pager counts. */
  matchedCount: number;
  page: number;
  pageCount: number;
};

/**
 * Locations a plan can ship FROM, warehouses first — the source picker. En-route
 * and ignore locations never appear: their stock isn't real distributable stock.
 * A branch is offered too, so a shop can rebalance between branches.
 */
export async function getTransferLocations(tenantId: string): Promise<TransferLocation[]> {
  const db = prismaForTenant(tenantId);
  const locations = await db.location.findMany({
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    include: { inventoryLevels: { select: { available: true, onHand: true } } },
  });

  return locations
    .map((location) => ({
      locationId: location.id,
      name: location.name,
      role: roleOf(location),
      isPrimary: location.isPrimary,
      // Movable units, not units present: stock already committed to an order
      // cannot be transferred out from under it.
      unitsOnHand: location.inventoryLevels.reduce(
        (sum, l) => sum + Math.max(0, sellableUnits(l)),
        0
      ),
    }))
    .filter((l) => l.role === "holds" || l.role === "sells")
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "holds" ? -1 : 1));
}

/**
 * Build the live proposal for a source location. Nothing is written — this is
 * the "what would I move today" view; saving it is a separate action.
 *
 * `notForSale` products (testers, display, damaged) are excluded: they are out
 * of sellable cover everywhere else, so moving them between branches would be
 * shifting stock nobody is going to sell.
 */
export async function getDistributionProposal(
  tenantId: string,
  {
    fromLocationId,
    coverDays = DEFAULT_COVER_DAYS,
    windowDays = DEFAULT_WINDOW_DAYS,
    canViewCosts,
    scope = EMPTY_TRANSFER_SCOPE,
    page = 0,
  }: {
    fromLocationId?: string;
    coverDays?: number;
    windowDays?: number;
    canViewCosts: boolean;
    /** Narrow which products are sized, by ABC class and/or category — applied
     *  BEFORE sizing, not after: the source's available units are divided
     *  across whichever products qualify, so filtering after sizing would
     *  report a move computed against a different (unfiltered) product set. */
    scope?: TransferScope;
    /** 0-based. Clamped to a real page — a stale link past the end shows the
     *  last page rather than nothing. */
    page?: number;
  }
): Promise<DistributionProposal | null> {
  const db = prismaForTenant(tenantId);
  const cover = clampCoverDays(coverDays);
  const window = clampWindowDays(windowDays);
  const since = new Date(Date.now() - window * DAY_MS);

  const locations = await db.location.findMany({
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    select: { id: true, name: true, locationType: true, isPrimary: true },
  });

  const source =
    (fromLocationId && locations.find((l) => l.id === fromLocationId)) ||
    locations.find((l) => roleOf(l) === "holds") ||
    null;
  const destinations = locations.filter((l) => isSellable(l) && l.id !== source?.id);
  if (!source || destinations.length === 0) return null;

  const [products, levels, attributed, metrics] = await Promise.all([
    db.product.findMany({
      where: { ...BUYABLE_PRODUCT_WHERE },
      select: { id: true, sku: true, title: true, costKes: true, abcCategory: true, customCategory: true },
      orderBy: { title: "asc" },
    }),
    // findMany + fold, not groupBy/_sum: SQL SUM skips NULLs, so a nullable
    // `available` cannot be reconciled against `onHand` per row inside an
    // aggregate. The unique key is already (locationId, productId).
    db.inventoryLevel.findMany({
      select: { productId: true, locationId: true, available: true, onHand: true },
    }),
    db.salesHistory.groupBy({
      by: ["productId", "locationId"],
      _sum: { quantity: true },
      where: { date: { gte: since }, locationId: { not: null } },
    }),
    getCatalogueMetrics(tenantId),
  ]);

  // Movable units per location: proposing to move stock that is already
  // promised to a customer is a transfer that cannot actually happen.
  const onHandAt = new Map<string, number>(
    levels.map((l) => [`${l.productId}:${l.locationId}`, sellableUnits(l)])
  );
  const soldAt = new Map<string, number>(
    attributed.map((a) => [`${a.productId}:${a.locationId}`, a._sum.quantity ?? 0])
  );
  const nameByLocation = new Map(destinations.map((l) => [l.id, l.name]));

  // What the source actually holds and has a rate for — the same two gates
  // the sizing loop below checks. Facet options and counts come from THIS
  // set, not every buyable product tenant-wide, or the filter bar would offer
  // (and count) categories the source doesn't stock a unit of.
  const sourceable = products.filter((p) => {
    const blended = metrics.get(p.id)?.runRate ?? 0;
    if (blended <= NO_RATE_EPSILON) return false;
    return (onHandAt.get(`${p.id}:${source.id}`) ?? 0) > 0;
  });
  const scopeFacets = deriveTransferScopeFacets(sourceable);

  const scoped = transferScopeActive(scope)
    ? sourceable.filter(
        (p) =>
          (scope.abc.length === 0 || scope.abc.includes(p.abcCategory ?? "")) &&
          (scope.category.length === 0 || scope.category.includes(p.customCategory ?? ""))
      )
    : sourceable;

  const lines: TransferLine[] = [];
  const destinationsWithSignal = new Set<string>();
  let hasAttributedDemand = false;

  for (const product of scoped) {
    // Both gates below were already checked building `sourceable` — scoped is
    // a subset of it, so neither can fail here. The lookups stay (cheap Map
    // reads) because `blended`/`available` are needed for sizing regardless.
    const blended = metrics.get(product.id)?.runRate ?? 0;
    const available = onHandAt.get(`${product.id}:${source.id}`) ?? 0;

    const positions = destinations.map((d) => ({
      locationId: d.id,
      onHand: onHandAt.get(`${product.id}:${d.id}`) ?? 0,
      attributedUnits: soldAt.get(`${product.id}:${d.id}`) ?? 0,
    }));
    const { basis, shareByLocation } = destinationShares(positions);
    for (const p of positions) {
      if ((shareByLocation.get(p.locationId) ?? 0) > 0) destinationsWithSignal.add(p.locationId);
    }

    const sized = sizeTransfers(
      available,
      positions.map((p) => ({
        locationId: p.locationId,
        onHand: p.onHand,
        runRate: blended * (shareByLocation.get(p.locationId) ?? 0),
      })),
      cover
    );
    if (sized.length > 0 && basis === "attributed") hasAttributedDemand = true;

    for (const line of sized) {
      lines.push({
        productId: product.id,
        sku: product.sku,
        title: product.title,
        abc: product.abcCategory,
        category: product.customCategory,
        toLocationId: line.toLocationId,
        toLocationName: nameByLocation.get(line.toLocationId) ?? "A branch",
        qty: line.qty,
        fromOnHand: available,
        toOnHand: line.toOnHand,
        toRunRate: line.toRunRate,
        toDaysCoverBefore: line.toDaysCoverBefore,
        toDaysCoverAfter: line.toDaysCoverAfter,
        rateBasis: basis,
        valueKes: canViewCosts ? line.qty * product.costKes : null,
      });
    }
  }

  // Biggest moves first, then alphabetically — a cost never enters the sort, so
  // a money-blind member sees the same rows in the same order as an owner.
  lines.sort(
    (a, b) => b.qty - a.qty || a.title.localeCompare(b.title) || a.toLocationName.localeCompare(b.toLocationName)
  );

  // Stat tiles, destination summaries and totals below all read the FULL
  // (unpaged) list — paging changes what is on screen and nothing else.
  const matchedCount = lines.length;
  const pageCount = Math.max(1, Math.ceil(matchedCount / PROPOSAL_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageLines = lines.slice(currentPage * PROPOSAL_PAGE_SIZE, currentPage * PROPOSAL_PAGE_SIZE + PROPOSAL_PAGE_SIZE);

  return {
    fromLocationId: source.id,
    fromLocationName: source.name,
    coverDays: cover,
    windowDays: window,
    lines: pageLines,
    allMatchedLines: lines,
    destinations: summariseDestinations(lines, destinations, canViewCosts),
    skipped: destinations
      .filter((d) => !destinationsWithSignal.has(d.id))
      .map((d) => ({ locationId: d.id, name: d.name, reason: "no-demand-signal" as const })),
    totalUnits: lines.reduce((sum, l) => sum + l.qty, 0),
    totalValueKes: canViewCosts ? lines.reduce((sum, l) => sum + (l.valueKes ?? 0), 0) : null,
    skuCount: new Set(lines.map((l) => l.productId)).size,
    hasAttributedDemand,
    scopeFacets,
    matchedCount,
    page: currentPage,
    pageCount,
  };
}

function summariseDestinations(
  lines: TransferLine[],
  destinations: { id: string; name: string }[],
  canViewCosts: boolean
): TransferDestinationSummary[] {
  return destinations
    .map((d) => {
      const own = lines.filter((l) => l.toLocationId === d.id);
      return {
        locationId: d.id,
        name: d.name,
        units: own.reduce((sum, l) => sum + l.qty, 0),
        skus: own.length,
        valueKes: canViewCosts ? own.reduce((sum, l) => sum + (l.valueKes ?? 0), 0) : null,
      };
    })
    .filter((d) => d.units > 0);
}

// ── Saved plans ──────────────────────────────────────────────────────────────

export type SavedPlanSummary = {
  id: string;
  name: string | null;
  status: string;
  fromLocationName: string;
  coverDays: number;
  windowDays: number;
  createdAt: Date;
  createdByName: string | null;
  lineCount: number;
  units: number;
  /** Null when the caller can't view costs. */
  valueKes: number | null;
};

export type SavedPlanLine = {
  id: string;
  productId: string;
  sku: string;
  title: string;
  toLocationId: string;
  toLocationName: string;
  qty: number;
  fromOnHand: number;
  toOnHand: number;
  toRunRate: number;
  toDaysCoverBefore: number | null;
  toDaysCoverAfter: number | null;
  status: string;
  /** Null when the caller can't view costs. */
  valueKes: number | null;
};

export type SavedPlan = SavedPlanSummary & { fromLocationId: string; lines: SavedPlanLine[] };

/** Unit costs for a set of plan lines. Lines snapshot sku/title at save time and
 *  the product id is deliberately not FK'd, so a product deleted since counts as
 *  zero rather than breaking the plan. */
async function costByProduct(
  tenantId: string,
  productIds: string[]
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const products = await prismaForTenant(tenantId).product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, costKes: true },
  });
  return new Map(products.map((p) => [p.id, p.costKes]));
}

/** The stored plan as the summary needs it — structural, so both the plain list
 *  and the paged screen can hand their rows to the same mapping. */
type PlanRecord = {
  id: string;
  name: string | null;
  status: string;
  coverDays: number;
  windowDays: number;
  createdAt: Date;
  createdByName: string | null;
  fromLocation: { name: string };
  lines: { productId: string; qty: number }[];
};

async function summarisePlans(
  tenantId: string,
  plans: PlanRecord[],
  canViewCosts: boolean
): Promise<SavedPlanSummary[]> {
  const costs = await costByProduct(
    tenantId,
    [...new Set(plans.flatMap((p) => p.lines.map((l) => l.productId)))]
  );

  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    status: plan.status,
    fromLocationName: plan.fromLocation.name,
    coverDays: plan.coverDays,
    windowDays: plan.windowDays,
    createdAt: plan.createdAt,
    createdByName: plan.createdByName,
    lineCount: plan.lines.length,
    units: plan.lines.reduce((sum, l) => sum + l.qty, 0),
    valueKes: canViewCosts
      ? plan.lines.reduce((sum, l) => sum + l.qty * (costs.get(l.productId) ?? 0), 0)
      : null,
  }));
}

/** The latest plans, newest first, capped at `limit`. The screen itself uses
 *  the paged form below. */
export async function listDistributionPlans(
  tenantId: string,
  { canViewCosts, limit = 20 }: { canViewCosts: boolean; limit?: number }
): Promise<SavedPlanSummary[]> {
  const plans = await prismaForTenant(tenantId).distributionPlan.findMany({
    where: { deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: {
      fromLocation: { select: { name: true } },
      lines: { select: { productId: true, qty: true } },
    },
  });
  return summarisePlans(tenantId, plans, canViewCosts);
}

// ── The saved-plans list: search and page ────────────────────────────────────

/** Saved plans on one page. Twenty was already the ceiling on this list — the
 *  twenty-first plan simply never appeared — so the number stays and the pager
 *  makes the rest reachable. */
export const SAVED_PLANS_PAGE_SIZE = 20;

export type SavedPlansQuery = {
  /** Free text, already trimmed. Empty means no filter. */
  search: string;
  page: number;
};

export const DEFAULT_SAVED_PLANS_QUERY: SavedPlansQuery = { search: "", page: 0 };

function onePlanParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function parseSavedPlansQuery(
  params: Record<string, string | string[] | undefined>
): SavedPlansQuery {
  const page = Number.parseInt(onePlanParam(params.page), 10);
  return {
    search: onePlanParam(params.q).trim().slice(0, 120),
    page: Number.isFinite(page) && page > 0 ? page : 0,
  };
}

/**
 * The plans list as a query string. `carry` is whatever else the transfers
 * screen holds — the source branch and the cover target belong to the proposal
 * above these rows, and searching or turning a page must not throw them away.
 */
export function savedPlansSearch(
  carry: { name: string; value: string }[],
  q: SavedPlansQuery
): string {
  const params = new URLSearchParams(carry.map((c) => [c.name, c.value]));
  if (q.search) params.set("q", q.search);
  if (q.page > 0) params.set("page", String(q.page));
  const search = params.toString();
  return search ? `?${search}` : "";
}

export type SavedPlansScreen = {
  /** One page of plans, newest first. */
  plans: SavedPlanSummary[];
  /** Plans saved, whatever is in the search box. Zero keeps the card away. */
  total: number;
  /** Plans the text matched: what the pager counts against. */
  matched: number;
  page: number;
  pageCount: number;
  /** 1-based index of the first row on the page ("showing 21–23 of 23"). */
  from: number;
};

/**
 * The saved-plans card: every plan counted, one page of them sent. The text
 * matches the two things written on the row — what the plan was called and the
 * branch it moves from. Neither is a cost, and the value column stays gated on
 * `canViewCosts` exactly as it was.
 */
export async function listDistributionPlansScreen(
  tenantId: string,
  { canViewCosts, query }: { canViewCosts: boolean; query: SavedPlansQuery }
): Promise<SavedPlansScreen> {
  const db = prismaForTenant(tenantId);
  const term = query.search;
  const where = {
    deletedAt: null,
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" as const } },
            { fromLocation: { is: { name: { contains: term, mode: "insensitive" as const } } } },
          ],
        }
      : {}),
  };

  const matched = await db.distributionPlan.count({ where });
  const total = term ? await db.distributionPlan.count({ where: { deletedAt: null } }) : matched;

  const pageCount = Math.max(1, Math.ceil(matched / SAVED_PLANS_PAGE_SIZE));
  const page = Math.min(Math.max(0, query.page), pageCount - 1);
  const start = page * SAVED_PLANS_PAGE_SIZE;

  // The id breaks a createdAt tie: two plans saved in the same millisecond must
  // not swap places between one page and the next, or the offset loses a row.
  const plans = await db.distributionPlan.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: start,
    take: SAVED_PLANS_PAGE_SIZE,
    include: {
      fromLocation: { select: { name: true } },
      lines: { select: { productId: true, qty: true } },
    },
  });

  return {
    plans: await summarisePlans(tenantId, plans, canViewCosts),
    total,
    matched,
    page,
    pageCount,
    from: start + 1,
  };
}

export async function getDistributionPlan(
  tenantId: string,
  planId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<SavedPlan | null> {
  const db = prismaForTenant(tenantId);
  const plan = await db.distributionPlan.findFirst({
    where: { id: planId, deletedAt: null },
    include: {
      fromLocation: { select: { name: true } },
      lines: { include: { toLocation: { select: { name: true } } } },
    },
  });
  if (!plan) return null;

  const costs = await costByProduct(tenantId, [...new Set(plan.lines.map((l) => l.productId))]);
  const lines = [...plan.lines]
    .sort((a, b) => b.qty - a.qty || a.title.localeCompare(b.title))
    .map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.sku,
      title: line.title,
      toLocationId: line.toLocationId,
      toLocationName: line.toLocation.name,
      qty: line.qty,
      fromOnHand: line.fromOnHand,
      toOnHand: line.toOnHand,
      toRunRate: line.toRunRate,
      toDaysCoverBefore: line.toDaysCoverBefore,
      toDaysCoverAfter: line.toDaysCoverAfter,
      status: line.status,
      valueKes: canViewCosts ? line.qty * (costs.get(line.productId) ?? 0) : null,
    }));

  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    fromLocationId: plan.fromLocationId,
    fromLocationName: plan.fromLocation.name,
    coverDays: plan.coverDays,
    windowDays: plan.windowDays,
    createdAt: plan.createdAt,
    createdByName: plan.createdByName,
    lineCount: lines.length,
    units: lines.reduce((sum, l) => sum + l.qty, 0),
    valueKes: canViewCosts ? lines.reduce((sum, l) => sum + (l.valueKes ?? 0), 0) : null,
    lines,
  };
}

/**
 * Save a proposal as a draft plan. The proposal is re-derived server-side by the
 * caller, never submitted by a client, so the stored lines always come from the
 * engine. Lines snapshot sku/title/cover so a finalised plan still reads
 * correctly after the catalogue moves on.
 */
export async function saveDistributionPlan(
  tenantId: string,
  proposal: DistributionProposal,
  { name, createdByName }: { name?: string | null; createdByName?: string | null } = {}
): Promise<string> {
  const db = prismaForTenant(tenantId);
  const plan = await db.distributionPlan.create({
    data: {
      tenantId,
      name: name?.trim() || null,
      fromLocationId: proposal.fromLocationId,
      coverDays: proposal.coverDays,
      windowDays: proposal.windowDays,
      createdByName: createdByName ?? null,
      lines: {
        // The FULL matched proposal, never the one page the screen happened to
        // be showing — a save must capture the whole plan whatever page the
        // person who clicked Save was looking at.
        create: proposal.allMatchedLines.map((line) => ({
          tenantId,
          productId: line.productId,
          sku: line.sku,
          title: line.title,
          toLocationId: line.toLocationId,
          qty: line.qty,
          fromOnHand: line.fromOnHand,
          toOnHand: line.toOnHand,
          toRunRate: line.toRunRate,
          toDaysCoverBefore: line.toDaysCoverBefore,
          toDaysCoverAfter: line.toDaysCoverAfter,
        })),
      },
    },
    select: { id: true },
  });
  return plan.id;
}

/** Rename a draft, or re-stamp it with a freshly sized set of lines. A finalised
 *  plan is a record of a decision, so only a draft can be re-sized. */
export async function updateDistributionPlan(
  tenantId: string,
  planId: string,
  { name, proposal }: { name?: string | null; proposal?: DistributionProposal }
): Promise<boolean> {
  const db = prismaForTenant(tenantId);
  const plan = await db.distributionPlan.findFirst({
    where: { id: planId, deletedAt: null, status: "draft" },
    select: { id: true },
  });
  if (!plan) return false;

  if (proposal) {
    await db.distributionPlanLine.deleteMany({ where: { planId } });
  }
  await db.distributionPlan.update({
    where: { id: planId },
    data: {
      ...(name !== undefined ? { name: name?.trim() || null } : {}),
      ...(proposal
        ? {
            fromLocationId: proposal.fromLocationId,
            coverDays: proposal.coverDays,
            windowDays: proposal.windowDays,
            lines: {
              // Full matched list, not whichever page was last rendered — see
              // the same note on saveDistributionPlan.
              create: proposal.allMatchedLines.map((line) => ({
                tenantId,
                productId: line.productId,
                sku: line.sku,
                title: line.title,
                toLocationId: line.toLocationId,
                qty: line.qty,
                fromOnHand: line.fromOnHand,
                toOnHand: line.toOnHand,
                toRunRate: line.toRunRate,
                toDaysCoverBefore: line.toDaysCoverBefore,
                toDaysCoverAfter: line.toDaysCoverAfter,
              })),
            },
          }
        : {}),
    },
  });
  return true;
}

/** Lock a draft as the plan the shop is picking against. The app is read-only to
 *  Shopify, so finalising records the decision and releases the CSV — it does
 *  not move a single unit in the store. */
export async function finaliseDistributionPlan(
  tenantId: string,
  planId: string
): Promise<boolean> {
  const db = prismaForTenant(tenantId);
  const updated = await db.distributionPlan.updateMany({
    where: { id: planId, deletedAt: null, status: "draft" },
    data: { status: "final" },
  });
  return updated.count > 0;
}

/** Soft-delete: plans are a decision record, so they leave a tombstone. */
export async function discardDistributionPlan(
  tenantId: string,
  planId: string
): Promise<boolean> {
  const db = prismaForTenant(tenantId);
  const updated = await db.distributionPlan.updateMany({
    where: { id: planId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return updated.count > 0;
}
