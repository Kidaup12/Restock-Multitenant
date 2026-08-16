import {
  BUYABLE_PRODUCT_WHERE,
  isSellable,
  prismaForTenant,
  roleOf,
  sellableUnits,
  type LocationRole,
} from "@wezesha/db";
import { getCatalogueMetrics } from "@/lib/metrics";

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

/** At or below this a destination has no measurable velocity — cover is
 *  undefined there. Matches the stock screen's "no run rate" threshold. */
const NO_RATE_EPSILON = 0.0001;

/** Target days of cover a plan levels every destination up to. */
export const DEFAULT_COVER_DAYS = 14;

/** Trailing window used to attribute demand to a branch. */
export const DEFAULT_WINDOW_DAYS = 90;

/** Cover horizons offered on the screen. */
export const COVER_DAY_CHOICES = [7, 14, 30] as const;

/** Guard rails for anything a client can influence. */
export const MIN_COVER_DAYS = 1;
export const MAX_COVER_DAYS = 180;
export const MIN_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 365;

// ── The sizing engine (pure) ─────────────────────────────────────────────────

export type DestinationPosition = {
  locationId: string;
  /** On-hand at this destination today. Negative = oversold: a hole to backfill. */
  onHand: number;
  /** This destination's share of the product's run rate (units/day). */
  runRate: number;
};

export type SizedTransfer = {
  toLocationId: string;
  /** Whole units to move. Never fractional, never more than the source holds. */
  qty: number;
  toOnHand: number;
  toRunRate: number;
  toDaysCoverBefore: number;
  toDaysCoverAfter: number;
};

const roundTo1 = (value: number): number => Math.round(value * 10) / 10;

/** Units a destination is short of a given cover level. Negative on-hand raises
 *  the need — the hole is real stock the branch owes its shelf. */
const shortfall = (d: DestinationPosition, level: number): number =>
  Math.max(0, d.runRate * level - d.onHand);

/**
 * The highest common cover level the available units can lift every destination
 * to (the classic level-fill). Exact rather than iterative: each destination
 * starts needing stock at level `onHand / runRate`, so walking those breakpoints
 * in order gives a segment on which the total need is linear in the level, and
 * the level is solved directly on the first segment that fits.
 */
function fillLevel(destinations: DestinationPosition[], available: number): number {
  const points = [...destinations].sort((a, b) => a.onHand / a.runRate - b.onHand / b.runRate);
  let rate = 0;
  let onHand = 0;
  for (let i = 0; i < points.length; i++) {
    rate += points[i]!.runRate;
    onHand += points[i]!.onHand;
    const next = points[i + 1];
    const level = (available + onHand) / rate;
    if (!next || level <= next.onHand / next.runRate) return level;
  }
  return 0; // unreachable: the last segment has no upper breakpoint
}

/**
 * Size one product's move out of a source holding `available` units.
 *
 * The rule: level-fill to a common days-of-cover. Every destination is lifted to
 * the same cover level — the target when the source can afford it, otherwise the
 * highest level the source can reach for everyone. That is what "equalise cover"
 * means; the alternative, splitting the shortfall proportionally, *preserves*
 * the imbalance it is meant to remove (the branch that started emptiest stays
 * emptiest), so it is used only to settle the rounding remainder below.
 *
 * The decisions this encodes, in order:
 *
 * 1. No run rate at a destination (`runRate <= NO_RATE_EPSILON`) → it receives
 *    nothing. There is no cover to equalise, and shipping stock to a branch with
 *    no measured demand manufactures the dead stock the product exists to kill.
 *    Opening stock for a genuinely new branch is a deliberate manual decision,
 *    not something a demand-driven plan should invent. Callers surface these
 *    destinations rather than dropping them silently.
 * 2. The source holds none of the product (`available <= 0`) → no lines. A
 *    negative (oversold) source position is treated as zero, never as a debt to
 *    push onto branches.
 * 3. Already at or above the level → that destination gets nothing; the units
 *    stay in the warehouse for the branches that are short.
 * 4. Source can't satisfy everyone → level-fill (above), which spends every
 *    available unit on the branches furthest below the achievable common cover.
 * 5. Rounding → floor each destination's fractional need, then hand the leftover
 *    whole units out by largest fractional part (ties to the faster seller, then
 *    by location id so the plan is deterministic). Total moved never exceeds the
 *    floor of what the source holds, and never exceeds the total need — the plan
 *    under-ships by at most one unit rather than over-shipping, because the unit
 *    left in the warehouse is still available to anyone.
 */
export function sizeTransfers(
  available: number,
  destinations: DestinationPosition[],
  coverDays: number
): SizedTransfer[] {
  const units = Math.floor(Math.max(0, available));
  const candidates = destinations.filter((d) => d.runRate > NO_RATE_EPSILON);
  if (units <= 0 || candidates.length === 0) return [];

  const needAtTarget = candidates.reduce((sum, d) => sum + shortfall(d, coverDays), 0);
  if (needAtTarget <= 0) return [];

  const level = needAtTarget <= units ? coverDays : fillLevel(candidates, units);

  const wants = candidates
    .map((d) => ({ d, want: shortfall(d, level) }))
    .filter((w) => w.want > 0);
  if (wants.length === 0) return [];

  // Float slack on the total only: the level solve lands on sums like 3.999…7,
  // and flooring that raw would silently strand a unit. Per-destination floors
  // stay exact so the floors can never out-run the budget.
  const budget = Math.min(units, Math.floor(wants.reduce((sum, w) => sum + w.want, 0) + 1e-9));
  const qtyByLocation = new Map(wants.map((w) => [w.d.locationId, Math.floor(w.want)]));
  let spare = budget - [...qtyByLocation.values()].reduce((sum, q) => sum + q, 0);

  const byRemainder = [...wants].sort(
    (a, b) =>
      (b.want - Math.floor(b.want)) - (a.want - Math.floor(a.want)) ||
      b.d.runRate - a.d.runRate ||
      a.d.locationId.localeCompare(b.d.locationId)
  );
  for (const w of byRemainder) {
    if (spare <= 0) break;
    qtyByLocation.set(w.d.locationId, (qtyByLocation.get(w.d.locationId) ?? 0) + 1);
    spare -= 1;
  }

  return wants
    .map(({ d }) => {
      const qty = qtyByLocation.get(d.locationId) ?? 0;
      return {
        toLocationId: d.locationId,
        qty,
        toOnHand: d.onHand,
        toRunRate: d.runRate,
        toDaysCoverBefore: roundTo1(Math.max(0, d.onHand) / d.runRate),
        toDaysCoverAfter: roundTo1(Math.max(0, d.onHand + qty) / d.runRate),
      };
    })
    .filter((line) => line.qty > 0);
}

/** How a product's per-destination run rate was derived — always shown, never
 *  presented as if it were measured when it isn't. */
export type RateBasis = "attributed" | "allocated" | "even";

/**
 * Split a product's blended run rate across destinations. The blended rate stays
 * the one engine number; only its SHARE per branch is derived here, in this
 * order of evidence:
 *
 *   "attributed" — the branch's own attributed sales in the window
 *     (SalesHistory.locationId). The only basis that is measured, and the only
 *     one under which branches genuinely differ in cover.
 *   "allocated"  — no attributed sales for this product anywhere: fall back to
 *     each branch's share of the stock it holds, the same approximation the
 *     stock screen documents for per-branch cover (lib/data/stock.ts). Note this
 *     makes every stocked branch land on identical cover, so a plan built on it
 *     is really "split the warehouse by where the stock already sits".
 *   "even"       — neither signal: the product sells (it has a blended rate) but
 *     no branch holds it or has attributed history, i.e. a shop-wide stockout.
 *     Split evenly and refill every branch.
 */
export function destinationShares(
  destinations: { locationId: string; onHand: number; attributedUnits: number }[]
): { basis: RateBasis; shareByLocation: Map<string, number> } {
  const attributed = destinations.reduce((sum, d) => sum + Math.max(0, d.attributedUnits), 0);
  if (attributed > 0) {
    return {
      basis: "attributed",
      shareByLocation: new Map(
        destinations.map((d) => [d.locationId, Math.max(0, d.attributedUnits) / attributed])
      ),
    };
  }
  const stocked = destinations.reduce((sum, d) => sum + Math.max(0, d.onHand), 0);
  if (stocked > 0) {
    return {
      basis: "allocated",
      shareByLocation: new Map(
        destinations.map((d) => [d.locationId, Math.max(0, d.onHand) / stocked])
      ),
    };
  }
  const even = destinations.length > 0 ? 1 / destinations.length : 0;
  return { basis: "even", shareByLocation: new Map(destinations.map((d) => [d.locationId, even])) };
}

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

export type DistributionProposal = {
  fromLocationId: string;
  fromLocationName: string;
  coverDays: number;
  windowDays: number;
  lines: TransferLine[];
  destinations: TransferDestinationSummary[];
  skipped: SkippedDestination[];
  totalUnits: number;
  /** Null when the caller can't view costs. */
  totalValueKes: number | null;
  /** SKUs the plan moves. */
  skuCount: number;
  /** True when at least one line rests on measured per-branch sales. */
  hasAttributedDemand: boolean;
};

/** Clamp a caller-supplied horizon into something a plan can be built on — the
 *  cover target rides in a URL and a re-size action, so neither is trusted. */
export function clampCoverDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_COVER_DAYS;
  return Math.min(MAX_COVER_DAYS, Math.max(MIN_COVER_DAYS, Math.round(value as number)));
}

export function clampWindowDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.round(value as number)));
}

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
  }: {
    fromLocationId?: string;
    coverDays?: number;
    windowDays?: number;
    canViewCosts: boolean;
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
      select: { id: true, sku: true, title: true, costKes: true },
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

  const lines: TransferLine[] = [];
  const destinationsWithSignal = new Set<string>();
  let hasAttributedDemand = false;

  for (const product of products) {
    const blended = metrics.get(product.id)?.runRate ?? 0;
    if (blended <= NO_RATE_EPSILON) continue; // nothing sells it — nothing to cover

    const available = onHandAt.get(`${product.id}:${source.id}`) ?? 0;
    if (available <= 0) continue; // the source holds none of it

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

  return {
    fromLocationId: source.id,
    fromLocationName: source.name,
    coverDays: cover,
    windowDays: window,
    lines,
    destinations: summariseDestinations(lines, destinations, canViewCosts),
    skipped: destinations
      .filter((d) => !destinationsWithSignal.has(d.id))
      .map((d) => ({ locationId: d.id, name: d.name, reason: "no-demand-signal" as const })),
    totalUnits: lines.reduce((sum, l) => sum + l.qty, 0),
    totalValueKes: canViewCosts ? lines.reduce((sum, l) => sum + (l.valueKes ?? 0), 0) : null,
    skuCount: new Set(lines.map((l) => l.productId)).size,
    hasAttributedDemand,
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
        create: proposal.lines.map((line) => ({
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
              create: proposal.lines.map((line) => ({
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
