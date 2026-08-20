import {
  OUTSTANDING_PO_STATUSES,
  Prisma,
  effectiveOnOrder,
  outstandingByProduct,
  prismaForTenant,
  prismaForTenantTx,
} from "@wezesha/db";
import { applyMoq } from "@/lib/po/po-math";
import {
  allocateByBudget,
  ASSUMED_LEAD_DAYS,
  coverDaysFor,
  explainQty,
  leadDaysFor,
  NO_STOCKOUT_DAYS,
  plannableReason,
  recommendedQty,
  type PlannableReason,
  type QtyExplanation,
} from "@wezesha/forecast";

/**
 * Plan-screen queries: the buy list built from the latest forecast run, the
 * budget split over it, and the add-to-order write. Server-only: every function
 * takes an explicit tenantId and runs on the RLS-enforced tenant client.
 *
 * `splitByBudget` is pure (rows in, split out) so tests can drive it directly
 * against engine output.
 *
 * Cost fields are redacted here, not at render: `getBuyList` takes an explicit
 * `canViewCosts` and nulls unit costs, line totals, and at-risk figures when it
 * is false, so a money-blind member's payload never carries the numbers. The
 * budget allocator still needs the real costs — actions run it on an
 * unredacted list server-side, then pass the split through `redactBudgetSplit`
 * before it leaves the server.
 */

const URGENCY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** What the planner's "Urgent only" lens keeps. One predicate, so the checklist,
 *  the decision header above it and anything exported from the screen cannot
 *  disagree about which rows are urgent. */
export function isUrgentRow(row: Pick<BuyListRow, "urgency">): boolean {
  return row.urgency === "critical" || row.urgency === "high";
}

/** An Order row counts as "already on the way" when the shop has actually
 *  committed to it: queued to buy (no purchase order yet), or on a purchase
 *  order that has been SENT.
 *
 *  A row sitting on an unsent DRAFT is not committed to anything. Creating a PO
 *  flips its queue rows to "ordered" in the same transaction that writes the PO
 *  as "draft" (lib/po/create-po.ts), so keying off the Order status alone took a
 *  stocked-out product off the buy list on the strength of a document nobody had
 *  posted — and, on a supplier with no email address, could not post. Those rows
 *  belong on the active list carrying `doubleOrderWarn`, which is what that flag
 *  was always for. */
const onTheWayOrderWhere: Prisma.OrderWhereInput = {
  receivedAt: null,
  OR: [
    // Queued to buy — no purchase order exists yet.
    { status: "pending" },
    // On a purchase order the supplier has actually been sent.
    {
      status: "ordered",
      purchaseOrder: { status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null },
    },
  ],
};

/** A "slow mover" the plan holds back: it has plenty of cover (urgency "low")
 *  AND the run sized less than this a day for it, so restocking now just ties up
 *  cash. Read against the SIZED daily demand, not the run rate — the two part
 *  company under a promo lift or the runaway cap, and this is the number the
 *  order would have been built from. */
const SLOW_MOVER_MAX_DAILY_DEMAND = 1; // < 1 unit/day

/** Horizon (days) for the "what deferring costs you" revenue-at-risk figure. */
const RISK_HORIZON_DAYS = 30;

/** Trailing window (days) for the per-product actual-revenue column. */
const REVENUE_WINDOW_DAYS = 30;

/**
 * How urgent placing the order is, keyed off the last safe day to order:
 * the day stock runs out minus the days the restock takes to arrive.
 */
export type BuyTier = "order_today" | "this_week" | "can_wait";

/** The run's own honesty words. Persisted per prediction by the engine; the UI
 *  translates them into shop language and never prints the token. */
export type PlanConfidence = "sure" | "fairly_sure" | "guessing";
export type PlanColdStart = "too_new" | "borrowed";

export type BuyListRow = {
  predictionId: string;
  productId: string;
  sku: string;
  title: string;
  vendor: string | null;
  supplierName: string | null;
  onHandUnits: number;
  onOrderUnits: number;
  /** Days of cover left, or null when the run rate is ~zero and the engine has
   *  no stockout in sight — the sentinel is resolved here so no screen or export
   *  can print it as a day count. */
  daysUntilStockout: number | null;
  /** Days left before ordering any later means a stockout: stockout minus lead time. */
  daysLeftToOrder: number;
  /** Lead time (days) — the same value subtracted to get daysLeftToOrder.
   *  Falls back to the shared ASSUMED_LEAD_DAYS when the product has neither an
   *  override nor a supplier average, so Plan and Stock agree on the verdict. */
  leadDays: number;
  /** Last safe day to order: run date + daysLeftToOrder. Consumers flag it overdue when past. */
  orderByDate: Date;
  urgency: string;
  tier: BuyTier;
  /** The quantity to order: the engine's number, or the owner's override when one
   *  is set for this product. Every qty-derived figure (line total, summary) uses it. */
  recommendedQty: number;
  /** The owner's override quantity when one exists for this product, else null.
   *  Lets the UI show "you set N" and offer a revert; keyed on productId so it
   *  survives the nightly re-plan that wipes and recreates predictions. */
  overriddenQty: number | null;
  /** How fast the product sells: the run's own rate, read back as persisted
   *  layer1Forecast30d / 30 — the engine's recency-weighted, stockout-corrected
   *  rate before the promo lift and the runaway cap, which is the same quantity
   *  Stock shows as "Sells/day". NOT finalForecast30d / 30: that is the SIZED
   *  30-day demand the order is built from, a different question, and printing
   *  it here had Plan and Stock 15-35% apart on the same product. */
  runRatePerDay: number;
  /** Supplier minimum order quantity (units); 1 when none is set. */
  moq: number;
  /** True when a cover horizon was asked for and this line's own lead time was
   *  longer, so the quantity covers the wait for its delivery rather than the
   *  horizon requested. Without it the number silently exceeds what was asked
   *  for and reads like a miscalculation. False whenever no cover lens is
   *  applied, and for a line the owner has overridden. */
  leadFloored: boolean;
  /** What will actually be ordered: recommendedQty raised to the supplier's
   *  minimum. The two differ whenever a supplier won't ship a small line, and
   *  every money figure uses THIS one — the plan used to price the pre-floor
   *  number while the purchase order billed the floored one, so a plan showing
   *  KES 1.08M of buying wrote KES 1.24M of orders. recommendedQty stays as the
   *  engine's own number: the MOQ note and recommended-vs-actual both need it. */
  orderQty: number;
  /** ABC class from the shared metric run; null when unranked or too new. */
  abc: string | null;
  /** Owner-defined grouping (the "Category" facet), from Product.customCategory;
   *  null = uncategorised. Metadata, not money — passed through to every role so
   *  the scope bar can filter by it. */
  category: string | null;
  /** Null when the caller can't view costs. */
  unitCostKes: number | null;
  /** recommendedQty x unit cost — what this line costs to order. Null when the
   *  caller can't view costs. */
  lineTotalKes: number | null;
  priceKes: number;
  /** The engine's own explanation of the recommendation. */
  reasoning: string;
  /**
   * Mean-cover arithmetic behind the quantity, attached only when it reproduces
   * the stored number exactly. Null for policy-driven quantities (min/max,
   * calibrated — their inputs aren't persisted, so the rule can't be re-run at
   * read time). Under the default tenant config every class resolves to a
   * policy rule, so most rows lean on `qtySummary` + `reasoning` instead.
   */
  explain: QtyExplanation | null;
  /** Always-true one-line arithmetic: what ordering this quantity brings the shelf to. */
  qtySummary: string;
  /** How far the run trusts this number, in the engine's own three words. Null
   *  only for a run written before the column existed. */
  confidence: PlanConfidence | null;
  /** "too_new" — on the shelf too briefly to have a sales pattern and no similar
   *  product to borrow from; "borrowed" — shaped on an established product's
   *  history; null — an ordinary forecast off its own sales. */
  coldStart: PlanColdStart | null;
  /** Title of the product whose shape was borrowed, resolved tenant-scoped. Null
   *  when nothing was borrowed OR the proxy no longer exists. The raw id never
   *  leaves the server — it would be a cross-tenant object-id oracle. */
  borrowedFromTitle: string | null;
  /** "ok", or why the budget planner can't reason about this row's economics. */
  plannable: PlannableReason;
  /** Revenue the forecast expects to miss over the next 30 days if this item is
   *  left to stock out. Gated with the cost figures: null when the caller
   *  can't view costs (the screens mask it behind the same permission). */
  atRiskKes: number | null;
  /** Trailing-30-day actual revenue for the product (all channels). A sales
   *  figure — visible to every role, matching Stock/Today's revenue30dKes. */
  revenue30dKes: number;
  /** True when this product also sits on an open DRAFT purchase order. The row
   *  stays on the active list — the PO isn't placed yet — but the UI warns that
   *  ordering it again would double up. Absent (undefined) when it isn't. */
  doubleOrderWarn?: boolean;
};

/** Why a product was held OFF the active buy list. Order of precedence when a
 *  product qualifies for more than one:
 *   - already-ordered: an open in-app Order (pending/ordered, not received) —
 *     it's on the way, re-recommending would double-order.
 *   - unplannable: the budget planner can't reason about its economics
 *     (missing/broken cost). The specific `plannable` reason rides on the row.
 *   - slow-mover: plenty of cover (urgency "low") AND selling below the
 *     slow-mover pace — the cash is better spent elsewhere first. */
export type ExcludedReason =
  | "already-ordered"
  | "unplannable"
  | "slow-mover"
  // Reasons for a product the run sized to ZERO. These never reached any screen
  // before: the qty filter dropped them ahead of the split, so 47 of the live
  // tenant's 49 forecast products simply vanished with nothing said about them.
  //   - too-new: no sales pattern yet, so there is nothing to forecast from.
  //   - covered: stock plus what's incoming already covers expected demand.
  | "too-new"
  | "covered";

/** An excluded row — a full buy-list row plus the typed reason it was held back.
 *  Surfaced read-only so nothing the run sized is ever silently dropped. */
export type ExcludedRow = BuyListRow & { reason: ExcludedReason };

export type BuyList = {
  forecastRunId: string;
  runDate: Date;
  /** Everything the run wants ordered and nothing blocks, most urgent first. */
  rows: BuyListRow[];
  /** Products the run sized but held OFF the active list, each tagged with why
   *  (already on the way, cost needs checking, too slow to stock now). Surfaced
   *  so the owner sees what was dropped and can act on it. */
  excluded: ExcludedRow[];
  /** Total products covered by the run (for the "n of m" subtitle). */
  totalPredicted: number;
  /** Cost of ordering the whole active list. Null when the caller can't view costs. */
  totalCostKes: number | null;
};

/** A row before redaction — what the allocator and totals arithmetic run on. */
type FullBuyListRow = BuyListRow & {
  unitCostKes: number;
  lineTotalKes: number;
  atRiskKes: number;
};

const redactRow = (r: BuyListRow): BuyListRow => ({
  ...r,
  unitCostKes: null,
  lineTotalKes: null,
  atRiskKes: null,
  // `plannable` is not money, but its values are ABOUT money: the UI renders
  // "cost is above the selling price — restocking this loses money" and "no unit
  // cost on file" from it, for every role. That is a cost fact reaching a
  // money-blind member through a derivation rather than a field — the same shape
  // as the cost-moved flag the suite already guards. Resolve it to "ok" so the
  // rows still appear and the notes do not.
  plannable: "ok",
});

/** Redact an excluded row's costs, keeping its reason — same money-blind masking
 *  as an active row (the reason is metadata, not money). The `unplannable` group
 *  is dropped outright: its whole purpose is to say a product's cost data is
 *  wrong, so a redacted version would be a heading with nothing behind it. */
const redactExcluded = (r: ExcludedRow): ExcludedRow => ({ ...redactRow(r), reason: r.reason });
const redactExcludedList = (rows: ExcludedRow[]): ExcludedRow[] =>
  rows.filter((r) => r.reason !== "unplannable").map(redactExcluded);

/** The persisted cover as a real day count, or null once it reaches the engine's
 *  "effectively forever" sentinel — a cover that far out is a ~zero run rate,
 *  not a date the shop can plan against. Resolved once, here, so the sentinel
 *  cannot reach a table cell, a CSV, or a printed PDF. */
const stockoutDaysLeft = (days: number): number | null =>
  days >= NO_STOCKOUT_DAYS ? null : days;

/** Sort key for "soonest stockout first" — no stockout in sight sorts last. */
const stockoutRank = (r: { daysUntilStockout: number | null }): number =>
  r.daysUntilStockout ?? Number.POSITIVE_INFINITY;

/** A before B before C; anything unclassified sorts after all three, since a
 *  product with no class is one the engine has too little history to rank. */
const ABC_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };
const abcRank = (r: { abc: string | null }): number => ABC_RANK[r.abc ?? ""] ?? 3;

/**
 * The shared head of every buy-list ordering: bestsellers first, then most
 * urgent, then whatever empties soonest. Neither key is money.
 *
 * Class leads on the client's instruction — the products that turn over fastest
 * and earn the most are the ones they want to see at the top of a buy list,
 * because those are where a stockout costs real money. The consequence is worth
 * stating plainly: a class-C item running out tomorrow now sits below class-A
 * items with weeks of cover. The urgency badge and the overdue banner still call
 * that out, and the budget split still funds criticals first — see splitByBudget,
 * which deliberately keeps its own ordering.
 */
const byUrgencyThenStockout = (a: BuyListRow, b: BuyListRow): number =>
  abcRank(a) - abcRank(b) ||
  (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9) ||
  stockoutRank(a) - stockoutRank(b);

/** Cost viewer's ordering: within a tie-group, the biggest line first. */
const byUrgencyCostAware = (a: FullBuyListRow, b: FullBuyListRow): number =>
  byUrgencyThenStockout(a, b) || b.lineTotalKes - a.lineTotalKes;

/**
 * Money-blind ordering: a cost never enters the sort, the same rule the transfer
 * proposal follows. Redaction nulls the line total but not the position it put
 * the row in — inside a tie-group that position IS the cost order, and since
 * `recommendedQty` stays visible, unit cost follows from it. So a money-blind
 * caller gets a deterministic order built from what they can already see:
 * the larger order first, then SKU to break the remaining ties.
 */
const byUrgencyCostFree = (a: BuyListRow, b: BuyListRow): number =>
  byUrgencyThenStockout(a, b) ||
  b.recommendedQty - a.recommendedQty ||
  a.sku.localeCompare(b.sku);

function tierFor(urgency: string, daysLeftToOrder: number): BuyTier {
  if (urgency === "critical" || daysLeftToOrder <= 0) return "order_today";
  if (daysLeftToOrder <= 7) return "this_week";
  return "can_wait";
}

/** Why this row is held off the active list, or null to keep it active. Order
 *  matters — already-ordered outranks a data problem, which outranks slow.
 *
 *  `plannedDailyDemand` is the SIZED demand (finalForecast30d / 30), passed in
 *  rather than read off the row: the row's own rate is the run rate now, and the
 *  two differ wherever a promo lift or the runaway cap applied. Which products
 *  the plan holds back is unchanged by that — this gate reads the same number it
 *  always has. */
function excludedReasonFor(
  row: { plannable: PlannableReason; urgency: string },
  plannedDailyDemand: number,
  hasOpenOrder: boolean
): ExcludedReason | null {
  if (hasOpenOrder) return "already-ordered";
  if (row.plannable !== "ok") return "unplannable";
  if (row.urgency === "low" && plannedDailyDemand < SLOW_MOVER_MAX_DAILY_DEMAND) return "slow-mover";
  return null;
}

/** Why a product the run sized to ZERO isn't on the list. `unplannable` and
 *  `slow-mover` are deliberately not reused: with nothing to buy, a cost problem
 *  is moot, and "sells slowly" isn't the reason — having enough already is. */
function notPlannedReasonFor(
  row: { coldStart: PlanColdStart | null },
  hasOpenOrder: boolean
): ExcludedReason {
  if (hasOpenOrder) return "already-ordered";
  if (row.coldStart === "too_new") return "too-new";
  return "covered";
}

/** The latest run's buy list, or null when no forecast has run yet. Rows are
 *  built on full costs and then redacted, but the ORDER follows the flag too:
 *  the cost tiebreak is a cost viewer's, a money-blind caller is ranked on
 *  cost-free keys (`byUrgencyCostFree`). Same rows either way, and the urgency /
 *  stockout ordering that decides what to buy first is unchanged.
 *
 *  `coverDays` and `demandUplift` are optional what-ifs on the same engine.
 *  Absent (uplift absent or 1), every quantity is the persisted plan and every
 *  field is byte-identical to before — the one-engine CI contract depends on
 *  this default path staying untouched. Present, every NON-overridden row is
 *  re-sized through the one engine (`recommendedQty`, the mean-cover branch):
 *    - `coverDays` sizes each line to that days-of-cover horizon, floored at the
 *      item's lead time.
 *    - `demandUplift` (a multiplier ≥ 1; 1.25 = +25%) lifts expected demand so
 *      the owner can size for a promotion/season, over the item's own lead+review
 *      cover.
 *  They compose: with both set, demand is lifted AND sized to the chosen cover.
 *  An owner override always wins and is never re-sized. Costs redact exactly as
 *  always — the re-sized `lineTotalKes` carries no new field. */
export async function getBuyList(
  tenantId: string,
  {
    canViewCosts,
    coverDays,
    demandUplift,
  }: { canViewCosts: boolean; coverDays?: number; demandUplift?: number }
): Promise<BuyList | null> {
  const db = prismaForTenant(tenantId);
  const latest = await db.prediction.findFirst({
    orderBy: { runDate: "desc" },
    select: { forecastRunId: true, runDate: true },
  });
  if (!latest) return null;

  const predictions = await db.prediction.findMany({
    where: { forecastRunId: latest.forecastRunId },
    select: {
      id: true,
      productId: true,
      daysUntilStockout: true,
      urgency: true,
      recommendedQty: true,
      finalForecast30d: true,
      // The run's own rate, promo/cap aside — layer1Forecast30d / 30 is exactly
      // the number the run itself sized safety stock, cover and urgency on.
      layer1Forecast30d: true,
      safetyStock: true,
      reasoning: true,
      regime: true,
      // The trust layer the run has always written and nothing has ever read.
      confidenceWord: true,
      coldStart: true,
      borrowedFromProductId: true,
      explainParts: true,
      product: {
        select: {
          sku: true,
          title: true,
          vendor: true,
          priceKes: true,
          costKes: true,
          currentStock: true,
          onOrder: true,
          leadTimeDays: true,
          abcCategory: true,
          customCategory: true,
          supplier: { select: { name: true, leadTimeAvgDays: true, leadTimeStdDays: true, moq: true } },
        },
      },
    },
  });

  const sized = predictions.map((p) => ({ ...p, qty: Math.round(p.recommendedQty) }));
  const kept = sized.filter((p) => p.qty > 0);
  // Everything the run sized to nothing. Built into rows too, so the owner can
  // see WHY a product they expected isn't on the list — they used to be dropped
  // here and never appear anywhere, not even under `excluded`.
  const zeroQty = sized.filter((p) => p.qty <= 0);
  // Per-product lookups below cover both sets. Widening them cannot change an
  // active row: every one is keyed by productId.
  const lookupIds = [...kept, ...zeroQty].map((p) => p.productId);

  // Owner overrides of the recommended quantity, keyed by productId so they
  // outlive the nightly re-plan (it wipes and recreates every prediction). A
  // product with no override is untouched below — the one-engine default.
  const overrideByProduct = new Map<string, number>();
  if (lookupIds.length > 0) {
    const overrides = await db.productPlanOverride.findMany({
      where: { productId: { in: lookupIds } },
      select: { productId: true, qty: true },
    });
    for (const o of overrides) overrideByProduct.set(o.productId, o.qty);
  }

  // Trailing-30-day actual revenue per buy-list product: one tenant-scoped SQL
  // sum. A sales figure — member-visible like Stock/Today's revenue30dKes, not
  // recomputed per screen.
  const revenueSince = new Date(Date.now() - REVENUE_WINDOW_DAYS * 86_400_000);
  const revenueByProduct = new Map<string, number>();
  if (lookupIds.length > 0) {
    const grouped = await db.salesHistory.groupBy({
      by: ["productId"],
      where: { productId: { in: lookupIds }, date: { gte: revenueSince } },
      _sum: { revenueKes: true },
    });
    for (const g of grouped) revenueByProduct.set(g.productId, g._sum.revenueKes ?? 0);
  }

  // What's already in flight for these products, so the plan stops re-recommending
  // it. Two independent signals, both tenant-scoped through the same client:
  //   - an in-app Order the shop has committed to (queued, or on a SENT purchase
  //     order) → drop from active.
  //   - a DRAFT purchase-order line → keep active, but warn on double-ordering.
  const onTheWayProductIds = new Set<string>();
  const draftPoProductIds = new Set<string>();
  // Units on a SENT PO are stock the shop has already paid for. The nightly run
  // counts them; this screen used to read Shopify's column alone, so between
  // sending a PO and the store recording the delivery it printed "On order: —"
  // and the what-if re-sizer recommended the same units again.
  let outstandingPoUnits = new Map<string, number>();
  if (lookupIds.length > 0) {
    const productIds = lookupIds;
    const [onTheWay, draftLines, sentLines] = await Promise.all([
      db.order.findMany({
        where: { productId: { in: productIds }, ...onTheWayOrderWhere },
        select: { productId: true },
      }),
      db.purchaseOrderLine.findMany({
        where: {
          productId: { in: productIds },
          purchaseOrder: { status: "draft", deletedAt: null },
        },
        select: { productId: true },
      }),
      db.purchaseOrderLine.findMany({
        where: {
          productId: { in: productIds },
          purchaseOrder: { status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null },
        },
        select: { productId: true, quantity: true, receivedQty: true },
      }),
    ]);
    for (const o of onTheWay) if (o.productId) onTheWayProductIds.add(o.productId);
    for (const l of draftLines) draftPoProductIds.add(l.productId);
    outstandingPoUnits = outstandingByProduct(sentLines);
  }

  // Titles for cold-start borrows. Tenant-scoped through the same client, so a
  // foreign id resolves to nothing; there is no FK on borrowedFromProductId and
  // Product has no soft delete, so a proxy that has since been deleted simply
  // misses the map and the row degrades to "a similar product".
  const borrowedTitleById = new Map<string, string>();
  const borrowedIds = [...new Set(sized.map((p) => p.borrowedFromProductId).filter((id) => !!id))];
  if (borrowedIds.length > 0) {
    const proxies = await db.product.findMany({
      where: { id: { in: borrowedIds as string[] } },
      select: { id: true, title: true },
    });
    for (const proxy of proxies) borrowedTitleById.set(proxy.id, proxy.title);
  }

  // What-if flags, resolved once. A demand uplift only counts when it lifts
  // (multiplier > 1) — a 1x (or absent) uplift is a no-op, so with no coverDays
  // the whole re-size path is skipped and every field stays byte-identical to
  // the persisted plan.
  const demandMultiplier = demandUplift != null && demandUplift > 1 ? demandUplift : 1;
  const whatIf = coverDays != null || demandMultiplier > 1;

  const buildRow = (p: (typeof sized)[number]): FullBuyListRow => {
      const product = p.product;
      // Two lenses on the same fact, and they must not be swapped. The measured
      // lead (null when there is none) floors the what-if SIZING below — a
      // guessed lead would inflate the order. The urgency lens has no such
      // option: `daysLeftToOrder`, the tier, and the order-by date are a
      // deadline the owner acts on, so an unknown lead resolves to the shared
      // assumption rather than to zero, which would say "order it the day the
      // shelf empties".
      // Shopify's incoming count OR our own outstanding POs, whichever is
      // larger — the same rule the nightly run sizes with (@wezesha/db/inbound).
      const inboundUnits = effectiveOnOrder(
        product.onOrder,
        outstandingPoUnits.get(p.productId) ?? 0
      );
      const measuredLeadDays = leadDaysFor(product, product.supplier);
      const leadDays = measuredLeadDays ?? ASSUMED_LEAD_DAYS;
      const daysLeftToOrder = p.daysUntilStockout - leadDays;
      const stockoutDays = Math.max(0, RISK_HORIZON_DAYS - p.daysUntilStockout);
      // The engine's number is the default; the owner's override wins when set.
      // With no override, `qty === p.qty` so every field below is byte-identical
      // to the pre-override behaviour — only overridden products diverge.
      //
      // What-if re-size: when a cover horizon or a demand uplift is in play,
      // re-size every NON-overridden row through the ONE engine —
      // `recommendedQty()` is `reorderBreakdown()`'s qty, the same function the
      // nightly pipeline persists with. No policy/abcCategory is passed, so it
      // takes the mean-cover branch. The two lenses compose:
      //   - demand: lifted by `demandMultiplier` (1x = no lift) for a sales push.
      //   - cover:  the passed `coverDays` floored at the item's MEASURED lead
      //     time when set, else the item's own lead+review window
      //     (`coverDaysFor`) — the natural mean-cover horizon, so an uplift-only
      //     re-size just scales the existing plan's demand.
      // An overridden row is never re-sized — the owner's number wins over any
      // what-if. With neither lens active, `whatIf` is false, `resizedQty` is
      // null and `qty === override ?? p.qty`, byte-identical to today.
      const override = overrideByProduct.get(p.productId) ?? null;
      // The horizon the re-size actually used. A measured lead longer than the
      // requested cover raises it, because a line has to cover the wait for its
      // own delivery — asking for 7 days from a 30-day supplier still buys 30.
      const sizeDays =
        coverDays != null ? Math.max(coverDays, measuredLeadDays ?? 0) : null;
      // One object, fed to BOTH the re-size and its explanation, so the breakdown
      // can never describe a different horizon from the one that set the number.
      const resizeInput =
        whatIf && override == null
          ? {
              finalForecast30d: p.finalForecast30d * demandMultiplier,
              safetyStock: p.safetyStock,
              currentStock: product.currentStock,
              onOrder: inboundUnits,
              coverDays: sizeDays ?? coverDaysFor(product, product.supplier),
            }
          : null;
      // Read off the same `sizeDays` the quantity was built from, so the badge
      // can never claim a flooring the number didn't get.
      const leadFloored =
        resizeInput != null && coverDays != null && sizeDays != null && sizeDays > coverDays;
      const resizedQty = resizeInput ? recommendedQty(resizeInput) : null;
      const qty = override ?? resizedQty ?? p.qty;
      // The supplier's floor is part of what this line costs, not a surprise
      // applied at PO time. applyMoq is the same function create-po runs — but
      // it floors at 1, and a row sized to zero is one we are NOT ordering
      // (covered, too new, already on order). Flooring those to 1 would put a
      // unit of cost against every product the plan deliberately left out.
      const orderQty = qty > 0 ? applyMoq(qty, product.supplier?.moq ?? 1) : 0;
      return {
        predictionId: p.id,
        productId: p.productId,
        sku: product.sku,
        title: product.title,
        vendor: product.vendor,
        supplierName: product.supplier?.name ?? null,
        // Sellable on-hand: Product.currentStock is the single source shared with
        // Today and Stock (the Sells-only rollup) — never a second sum here.
        onHandUnits: product.currentStock,
        onOrderUnits: inboundUnits,
        daysUntilStockout: stockoutDaysLeft(p.daysUntilStockout),
        daysLeftToOrder,
        leadDays,
        orderByDate: new Date(latest.runDate.getTime() + daysLeftToOrder * 86_400_000),
        urgency: p.urgency,
        tier: tierFor(p.urgency, daysLeftToOrder),
        recommendedQty: qty,
        orderQty,
        overriddenQty: override,
        runRatePerDay: r1(p.layer1Forecast30d / 30),
        moq: product.supplier?.moq ?? 1,
        leadFloored,
        abc: product.abcCategory,
        category: product.customCategory,
        unitCostKes: product.costKes,
        lineTotalKes: orderQty * product.costKes,
        priceKes: product.priceKes,
        reasoning: p.reasoning,
        explain: explainFor(p.explainParts, qty, resizeInput, override),
        qtySummary: buildQtySummary(p, qty),
        confidence: asConfidence(p.confidenceWord),
        coldStart: asColdStart(p.coldStart),
        borrowedFromTitle: p.borrowedFromProductId
          ? (borrowedTitleById.get(p.borrowedFromProductId) ?? null)
          : null,
        plannable: plannableReason(product),
        atRiskKes: Math.round((p.finalForecast30d / RISK_HORIZON_DAYS) * product.priceKes * stockoutDays),
        revenue30dKes: revenueByProduct.get(p.productId) ?? 0,
        // Draft-PO overlap is a warn, not a drop: keep the row active but flag it.
        doubleOrderWarn: draftPoProductIds.has(p.productId) || undefined,
      };
  };

  // Each row travels with the sized daily demand its prediction carried — the
  // slow-mover gate reads that, not the row's run rate.
  const built = kept.map((p) => ({ row: buildRow(p), plannedDailyDemand: p.finalForecast30d / 30 }));

  // Split the sized rows: hold already-ordered / unplannable / slow-mover
  // products OFF the active list (surfaced under `excluded`, never silently
  // dropped), keep the rest. Both paths — default and cover-days what-if —
  // classify the same way; the reasons key off the persisted forecast, so a
  // what-if horizon never changes what's excluded.
  const activeRows: FullBuyListRow[] = [];
  const excludedRows: (FullBuyListRow & { reason: ExcludedReason })[] = [];
  for (const { row, plannedDailyDemand } of built) {
    const reason = excludedReasonFor(row, plannedDailyDemand, onTheWayProductIds.has(row.productId));
    if (reason) excludedRows.push({ ...row, reason });
    else activeRows.push(row);
  }

  // Products the run sized to nothing, appended AFTER the split so the three
  // existing groups and the active list are untouched. Each carries the reason
  // it isn't being ordered — the question the owner actually asks of a plan is
  // "why isn't X here?", and until now no screen answered it.
  for (const p of zeroQty) {
    const row = buildRow(p);
    excludedRows.push({ ...row, reason: notPlannedReasonFor(row, onTheWayProductIds.has(row.productId)) });
  }

  // The ordering follows the flag: a money-blind caller's rows are ranked on
  // cost-free keys, so the sequence they receive says nothing about cost.
  const byUrgency = canViewCosts ? byUrgencyCostAware : byUrgencyCostFree;
  activeRows.sort(byUrgency);
  excludedRows.sort(byUrgency);

  // A what-if re-size can zero out a row that no longer needs ordering at the
  // chosen cover (a demand uplift only raises quantities, but it composes with a
  // short cover that can); drop those so the checklist never shows an "order 0"
  // line. Only the what-if path filters — the default path keeps active rows
  // untouched, so the one-engine contract stays byte-identical.
  const sizedRows = whatIf ? activeRows.filter((r) => r.recommendedQty > 0) : activeRows;

  return {
    forecastRunId: latest.forecastRunId,
    runDate: latest.runDate,
    rows: canViewCosts ? sizedRows : sizedRows.map(redactRow),
    excluded: canViewCosts ? excludedRows : redactExcludedList(excludedRows),
    totalPredicted: predictions.length,
    totalCostKes: canViewCosts ? sizedRows.reduce((sum, r) => sum + r.lineTotalKes, 0) : null,
  };
}

/** Null out every KES figure in a buy list for a money-blind caller — the row
 *  list and counts survive, the money does not. Reuses the same `redactRow`, so
 *  an action can fetch a buy list with costs and redact on the way out to the
 *  caller's own cost visibility.
 *
 *  Re-sorts as well as redacts. A list fetched with costs visible came back in
 *  the cost-aware order, and that order outlives the nulled fields — so it is
 *  rebuilt on the cost-free keys, leaving the caller exactly what `getBuyList`
 *  would have handed them directly. */
export function redactBuyList(buyList: BuyList, canViewCosts: boolean): BuyList {
  if (canViewCosts) return buyList;
  return {
    ...buyList,
    rows: buyList.rows.map(redactRow).sort(byUrgencyCostFree),
    excluded: redactExcludedList(buyList.excluded).sort(byUrgencyCostFree),
    totalCostKes: null,
  };
}

const CONFIDENCE_WORDS = new Set<string>(["sure", "fairly_sure", "guessing"]);
const COLD_START_STATES = new Set<string>(["too_new", "borrowed"]);

const asConfidence = (v: string | null): PlanConfidence | null =>
  v && CONFIDENCE_WORDS.has(v) ? (v as PlanConfidence) : null;
const asColdStart = (v: string | null): PlanColdStart | null =>
  v && COLD_START_STATES.has(v) ? (v as PlanColdStart) : null;

/** `Prediction.explainParts` is a Json column, and rows written by hand (tests,
 *  fixtures) carry none — so it is narrowed rather than trusted. */
function asQtyExplanation(v: unknown): QtyExplanation | null {
  if (typeof v !== "object" || v === null) return null;
  const parts = v as Partial<QtyExplanation>;
  return typeof parts.summary === "string" && typeof parts.recommendedQty === "number"
    ? (parts as QtyExplanation)
    : null;
}

/**
 * The explanation for the quantity actually shown, from the same source that
 * decided it:
 *   - owner override → none. No engine rule produced that number, and
 *     `qtySummary` plus the "you set N" affordance already say so.
 *   - what-if re-size → the ONE engine again on the SAME input the re-size used,
 *     so the breakdown describes the horizon the owner asked for. A numeric
 *     equality check is not enough here: re-sizing at exactly the item's own
 *     cover reproduces the persisted quantity, so the stored parts would match
 *     the number while describing a different window.
 *   - otherwise → the run's OWN persisted breakdown, read back rather than
 *     recomputed. This is what gives min/max and calibrated rows a real "why";
 *     recomputing could only ever redo the mean-cover branch, so it returned
 *     null for every policy-driven row — most of the catalogue.
 * Kept only when it still lands on the shown number: stock drifts after a run,
 * and a breakdown that doesn't sum to the number is worse than none.
 */
function explainFor(
  storedParts: unknown,
  qty: number,
  resizeInput: Parameters<typeof explainQty>[0] | null,
  override: number | null
): QtyExplanation | null {
  if (override != null) return null;
  if (resizeInput) return explainQty(resizeInput, qty);
  const stored = asQtyExplanation(storedParts);
  return stored && stored.recommendedQty === qty ? stored : null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The identity that holds for every rule: ordering the quantity brings the
 *  shelf to stock + incoming + order. Built from stored outputs and today's
 *  position, so it stays true even after the run's inputs have drifted. */
function buildQtySummary(
  p: {
    finalForecast30d: number;
    safetyStock: number;
    product: { currentStock: number; onOrder: number };
  },
  storedQty: number
): string {
  const target = r1(p.product.currentStock + p.product.onOrder + storedQty);
  return (
    `${r1(p.product.currentStock)} in stock + ${r1(p.product.onOrder)} incoming` +
    ` + ${storedQty} ordered = ${target}` +
    ` (forecast ${r1(p.finalForecast30d / 30)}/day, buffer ${r1(p.safetyStock)})`
  );
}

export type BudgetSplit = {
  budgetKes: number;
  /** Bought within (or forced over) the budget, priority order. */
  funded: BuyListRow[];
  /** Held for later, priority order — each row's atRiskKes is what waiting costs. */
  deferred: BuyListRow[];
  /** Rows the allocator can't reason about (missing/broken cost data) — surfaced, never silently dropped. */
  checkCost: BuyListRow[];
  /** The KES aggregates are null after `redactBudgetSplit` for a money-blind caller. */
  fundedCostKes: number | null;
  deferredCostKes: number | null;
  /** Revenue the forecast expects to miss in the next 30 days if the deferred items stay unfunded. */
  deferredAtRiskKes: number | null;
  /** Budget still unspent after funding. */
  leftoverKes: number | null;
  /** How far the plan exceeds the budget. Always 0 under a cap; non-zero only
   *  when the caller allowed criticals to overflow it. */
  overBudgetKes: number | null;
  /** Must-restock lines the cap left unfunded. Zero unless capping. */
  deferredCriticalCount: number;
  /** What it would cost to bring those must-restock lines back in. */
  deferredCriticalKes: number | null;
  /** How many rows the allocator had to work with, and how many the plan is
   *  holding back. Counts, not money — they survive redaction — and they are
   *  what tells "the budget didn't stretch" apart from "there was nothing to
   *  spend it on". Advising a shop to raise an untouched budget points them away
   *  from the real cause, which is a buy list held back for missing costs or
   *  open orders. */
  incomingCount: number;
  heldBackCount: number;
  /** True when the split was withheld from a money-blind caller: the three row
   *  lists are empty and every figure is null, because the split itself reads
   *  costs out. Absent otherwise. Consumers should say so rather than render an
   *  empty plan. */
  withheld?: boolean;
};

/**
 * Split the buy list against a cash cap. Priority: urgency first, then the
 * revenue at risk, then how soon the stockout lands — the budget goes where it
 * earns most.
 *
 * **The budget caps by default.** A cap a plan can exceed is not a budget, and a
 * plan the shop cannot pay for is not one it can act on. Criticals still sort
 * first, so they are the last thing dropped; any that still do not fit are
 * deferred and counted in `deferredCriticalCount` so the screen can say what the
 * cap is costing rather than quietly leaving a stockout in the plan.
 *
 * `strict: false` restores the older behaviour — criticals funded whatever the
 * budget, the overrun reported in `overBudgetKes`. That is the shop's choice to
 * make ("let criticals exceed budget"), not a default to inherit.
 *
 * Expects an unredacted list (real costs) — callers acting for a money-blind
 * member fetch with costs visible, split, then `redactBudgetSplit` the result.
 */
export function splitByBudget(
  rows: BuyListRow[],
  budgetKes: number,
  { strict = true, heldBackCount = 0 }: { strict?: boolean; heldBackCount?: number } = {}
): BudgetSplit {
  const checkCost = rows.filter((r) => r.plannable !== "ok");
  const scored = rows
    .filter((r) => r.plannable === "ok" && (r.lineTotalKes ?? 0) > 0)
    // Deliberately NOT the list's ordering: money is allocated most-urgent
    // first, whatever the class. The list leads with bestsellers because that
    // is how a buyer wants to read it, but a budget that spent on class A while
    // a critical item went unfunded would be a stockout the shop paid for.
    .sort(
      (a, b) =>
        (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9) ||
        (b.atRiskKes ?? 0) - (a.atRiskKes ?? 0) ||
        stockoutRank(a) - stockoutRank(b)
    )
    .map((row) => ({ row, cost: row.lineTotalKes ?? 0, urgency: row.urgency }));

  const { selected, deferred, usedKes } = allocateByBudget(scored, budgetKes, strict);
  const deferredRows = deferred.map((s) => s.row);
  const deferredCriticals = deferredRows.filter((r) => r.urgency === "critical");

  return {
    budgetKes,
    funded: selected.map((s) => s.row),
    deferred: deferredRows,
    checkCost,
    fundedCostKes: usedKes,
    deferredCostKes: deferredRows.reduce((sum, r) => sum + (r.lineTotalKes ?? 0), 0),
    deferredAtRiskKes: deferredRows.reduce((sum, r) => sum + (r.atRiskKes ?? 0), 0),
    leftoverKes: Math.max(0, budgetKes - usedKes),
    overBudgetKes: Math.max(0, usedKes - budgetKes),
    deferredCriticalCount: deferredCriticals.length,
    deferredCriticalKes: deferredCriticals.reduce((sum, r) => sum + (r.lineTotalKes ?? 0), 0),
    incomingCount: rows.length,
    heldBackCount,
  };
}

/**
 * Withhold a budget split from a money-blind caller.
 *
 * Nulling the KES aggregates is not enough here, because the funded/deferred
 * partition is itself the cost figure: which rows fit under a cap is a pure
 * function of their line totals against a budget the caller chooses, so running
 * the same list against different budgets narrows every row's cost by bisection.
 * There is no redacted form of that answer — so a money-blind caller gets no
 * split at all, flagged `withheld` so the caller can say why rather than show an
 * empty plan.
 *
 * This is the data layer refusing to compute a cost answer for someone who may
 * not see costs; the caller should not reach it in the first place. A cost
 * viewer's split passes through untouched.
 */
export function redactBudgetSplit(split: BudgetSplit, canViewCosts: boolean): BudgetSplit {
  if (canViewCosts) return split;
  return {
    budgetKes: split.budgetKes, // the caller's own input, not an answer
    funded: [],
    deferred: [],
    checkCost: [],
    fundedCostKes: null,
    deferredCostKes: null,
    deferredAtRiskKes: null,
    leftoverKes: null,
    overBudgetKes: null,
    deferredCriticalCount: 0,
    deferredCriticalKes: null,
    // Withheld entirely — the screen says so rather than rendering an empty plan,
    // so these carry nothing either.
    incomingCount: 0,
    heldBackCount: 0,
    withheld: true,
  };
}

export type CreateOrdersResult = {
  created: number;
  updated: number;
  /** Ids that resolved to nothing under this tenant's scope. */
  skipped: number;
};

/**
 * Add ticked buy-list lines to Orders as status "pending" — one Order per
 * prediction, re-adding updates the existing pending row instead of stacking
 * duplicates. Atomic, and RLS-scoped end to end: prediction ids from another
 * tenant resolve to nothing, and the WITH CHECK policy rejects any write that
 * names a foreign tenant.
 */
export async function createOrdersForPredictions(
  tenantId: string,
  predictionIds: string[]
): Promise<CreateOrdersResult> {
  return prismaForTenantTx(tenantId, async (tx) => {
    const predictions = await tx.prediction.findMany({
      where: { id: { in: predictionIds } },
      select: {
        id: true,
        productId: true,
        recommendedQty: true,
        product: { select: { currentStock: true } },
      },
    });

    let created = 0;
    let updated = 0;
    for (const p of predictions) {
      const qty = Math.max(1, Math.round(p.recommendedQty));
      const existing = await tx.order.findFirst({
        where: { predictionId: p.id, status: "pending" },
        select: { id: true },
      });
      if (existing) {
        await tx.order.update({
          where: { id: existing.id },
          data: { orderedQty: qty, stockAtOrder: p.product.currentStock },
        });
        updated += 1;
      } else {
        await tx.order.create({
          data: {
            tenantId,
            predictionId: p.id,
            productId: p.productId,
            status: "pending",
            orderedQty: qty,
            stockAtOrder: p.product.currentStock,
          },
        });
        created += 1;
      }
    }
    return { created, updated, skipped: predictionIds.length - predictions.length };
  });
}

export type PlanOverrideInput = {
  productId: string;
  qty: number;
  createdByUserId?: string | null;
  createdByName?: string | null;
};

/** The productId named by an override doesn't belong to the caller's workspace
 *  (or doesn't exist). Callers turn this into a refusal the owner can read. */
export class UnknownProductError extends Error {
  constructor(productId: string) {
    super(`product ${productId} is not in this workspace`);
    this.name = "UnknownProductError";
  }
}

/**
 * Set (or replace) this tenant's owner override of the recommended order
 * quantity for a product. Upsert on the (tenantId, productId) unique — one
 * standing override per product, updated in place.
 *
 * The productId arrives from the browser, and RLS cannot vet it: the policy
 * filters ROWS, so it rejects an UPDATE of someone else's override but has
 * nothing to filter on a CREATE, where no row exists yet. Nor does the database
 * — ProductPlanOverride carries no foreign key on productId, and none carrying a
 * tenant is expressible without a (tenantId, id) key on Product. So the guard is
 * a scoped READ of the product first: under RLS that read can only see this
 * workspace's catalogue, and a foreign id resolves to nothing.
 */
export async function upsertPlanOverride(
  tenantId: string,
  input: PlanOverrideInput
): Promise<void> {
  const qty = Math.round(input.qty);
  const db = prismaForTenant(tenantId);
  const owned = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true },
  });
  if (!owned) throw new UnknownProductError(input.productId);
  await db.productPlanOverride.upsert({
    where: { tenantId_productId: { tenantId, productId: input.productId } },
    create: {
      tenantId,
      productId: input.productId,
      qty,
      createdByUserId: input.createdByUserId ?? null,
      createdByName: input.createdByName ?? null,
    },
    update: { qty },
  });
}

/** Drop this tenant's override for a product — the buy list reverts to the
 *  engine's recommendation. A foreign productId matches nothing under RLS. */
export async function removePlanOverride(tenantId: string, productId: string): Promise<void> {
  const db = prismaForTenant(tenantId);
  await db.productPlanOverride.deleteMany({ where: { productId } });
}
