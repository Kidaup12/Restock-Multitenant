import { prismaForTenant, prismaForTenantTx } from "@wezesha/db";
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

/** Open Order statuses = queued to buy or on a live PO, not yet received or
 *  cancelled. A product with one of these is already on the way. Mirrors the
 *  supply calendar's definition so the two screens agree on "already on order". */
const OPEN_ORDER_STATUSES = ["pending", "ordered"];

/** A "slow mover" the plan holds back: it has plenty of cover (urgency "low")
 *  AND sells below this daily pace, so restocking now just ties up cash. */
const SLOW_MOVER_MAX_RUN_RATE = 1; // < 1 unit/day

/** Horizon (days) for the "what deferring costs you" revenue-at-risk figure. */
const RISK_HORIZON_DAYS = 30;

/** Trailing window (days) for the per-product actual-revenue column. */
const REVENUE_WINDOW_DAYS = 30;

/**
 * How urgent placing the order is, keyed off the last safe day to order:
 * the day stock runs out minus the days the restock takes to arrive.
 */
export type BuyTier = "order_today" | "this_week" | "can_wait";

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
  /** Forecast daily run rate — persisted finalForecast30d / 30 (the one engine, not re-derived). */
  runRatePerDay: number;
  /** Supplier minimum order quantity (units); 1 when none is set. */
  moq: number;
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
export type ExcludedReason = "already-ordered" | "unplannable" | "slow-mover";

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
});

/** Redact an excluded row's costs, keeping its reason — same money-blind masking
 *  as an active row (the reason is metadata, not money). */
const redactExcluded = (r: ExcludedRow): ExcludedRow => ({ ...redactRow(r), reason: r.reason });

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
 *  matters — already-ordered outranks a data problem, which outranks slow. */
function excludedReasonFor(
  row: { plannable: PlannableReason; urgency: string; runRatePerDay: number },
  hasOpenOrder: boolean
): ExcludedReason | null {
  if (hasOpenOrder) return "already-ordered";
  if (row.plannable !== "ok") return "unplannable";
  if (row.urgency === "low" && row.runRatePerDay < SLOW_MOVER_MAX_RUN_RATE) return "slow-mover";
  return null;
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
      safetyStock: true,
      reasoning: true,
      regime: true,
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

  const kept = predictions
    .map((p) => ({ ...p, qty: Math.round(p.recommendedQty) }))
    .filter((p) => p.qty > 0);

  // Owner overrides of the recommended quantity, keyed by productId so they
  // outlive the nightly re-plan (it wipes and recreates every prediction). A
  // product with no override is untouched below — the one-engine default.
  const overrideByProduct = new Map<string, number>();
  if (kept.length > 0) {
    const overrides = await db.productPlanOverride.findMany({
      where: { productId: { in: kept.map((p) => p.productId) } },
      select: { productId: true, qty: true },
    });
    for (const o of overrides) overrideByProduct.set(o.productId, o.qty);
  }

  // Trailing-30-day actual revenue per buy-list product: one tenant-scoped SQL
  // sum. A sales figure — member-visible like Stock/Today's revenue30dKes, not
  // recomputed per screen.
  const revenueSince = new Date(Date.now() - REVENUE_WINDOW_DAYS * 86_400_000);
  const revenueByProduct = new Map<string, number>();
  if (kept.length > 0) {
    const grouped = await db.salesHistory.groupBy({
      by: ["productId"],
      where: { productId: { in: kept.map((p) => p.productId) }, date: { gte: revenueSince } },
      _sum: { revenueKes: true },
    });
    for (const g of grouped) revenueByProduct.set(g.productId, g._sum.revenueKes ?? 0);
  }

  // What's already in flight for these products, so the plan stops re-recommending
  // it. Two independent signals, both tenant-scoped through the same client:
  //   - an OPEN in-app Order (pending/ordered, not received) → drop from active.
  //   - a DRAFT purchase-order line → keep active, but warn on double-ordering.
  const openOrderProductIds = new Set<string>();
  const draftPoProductIds = new Set<string>();
  if (kept.length > 0) {
    const productIds = kept.map((p) => p.productId);
    const [openOrders, draftLines] = await Promise.all([
      db.order.findMany({
        where: {
          productId: { in: productIds },
          status: { in: OPEN_ORDER_STATUSES },
          receivedAt: null,
        },
        select: { productId: true },
      }),
      db.purchaseOrderLine.findMany({
        where: {
          productId: { in: productIds },
          purchaseOrder: { status: "draft", deletedAt: null },
        },
        select: { productId: true },
      }),
    ]);
    for (const o of openOrders) if (o.productId) openOrderProductIds.add(o.productId);
    for (const l of draftLines) draftPoProductIds.add(l.productId);
  }

  // What-if flags, resolved once. A demand uplift only counts when it lifts
  // (multiplier > 1) — a 1x (or absent) uplift is a no-op, so with no coverDays
  // the whole re-size path is skipped and every field stays byte-identical to
  // the persisted plan.
  const demandMultiplier = demandUplift != null && demandUplift > 1 ? demandUplift : 1;
  const whatIf = coverDays != null || demandMultiplier > 1;

  const built = kept
    .map((p): FullBuyListRow => {
      const product = p.product;
      // Two lenses on the same fact, and they must not be swapped. The measured
      // lead (null when there is none) floors the what-if SIZING below — a
      // guessed lead would inflate the order. The urgency lens has no such
      // option: `daysLeftToOrder`, the tier, and the order-by date are a
      // deadline the owner acts on, so an unknown lead resolves to the shared
      // assumption rather than to zero, which would say "order it the day the
      // shelf empties".
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
      const resizedQty =
        whatIf && override == null
          ? recommendedQty({
              finalForecast30d: p.finalForecast30d * demandMultiplier,
              safetyStock: p.safetyStock,
              currentStock: product.currentStock,
              onOrder: product.onOrder,
              coverDays:
                coverDays != null
                  ? Math.max(coverDays, measuredLeadDays ?? 0)
                  : coverDaysFor(product, product.supplier),
            })
          : null;
      const qty = override ?? resizedQty ?? p.qty;
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
        onOrderUnits: product.onOrder,
        daysUntilStockout: stockoutDaysLeft(p.daysUntilStockout),
        daysLeftToOrder,
        leadDays,
        orderByDate: new Date(latest.runDate.getTime() + daysLeftToOrder * 86_400_000),
        urgency: p.urgency,
        tier: tierFor(p.urgency, daysLeftToOrder),
        recommendedQty: qty,
        overriddenQty: override,
        runRatePerDay: r1(p.finalForecast30d / 30),
        moq: product.supplier?.moq ?? 1,
        abc: product.abcCategory,
        category: product.customCategory,
        unitCostKes: product.costKes,
        lineTotalKes: qty * product.costKes,
        priceKes: product.priceKes,
        reasoning: p.reasoning,
        explain: buildExplain(p, qty),
        qtySummary: buildQtySummary(p, qty),
        plannable: plannableReason(product),
        atRiskKes: Math.round((p.finalForecast30d / RISK_HORIZON_DAYS) * product.priceKes * stockoutDays),
        revenue30dKes: revenueByProduct.get(p.productId) ?? 0,
        // Draft-PO overlap is a warn, not a drop: keep the row active but flag it.
        doubleOrderWarn: draftPoProductIds.has(p.productId) || undefined,
      };
    });

  // Split the sized rows: hold already-ordered / unplannable / slow-mover
  // products OFF the active list (surfaced under `excluded`, never silently
  // dropped), keep the rest. Both paths — default and cover-days what-if —
  // classify the same way; the reasons key off the persisted forecast, so a
  // what-if horizon never changes what's excluded.
  const activeRows: FullBuyListRow[] = [];
  const excludedRows: (FullBuyListRow & { reason: ExcludedReason })[] = [];
  for (const row of built) {
    const reason = excludedReasonFor(row, openOrderProductIds.has(row.productId));
    if (reason) excludedRows.push({ ...row, reason });
    else activeRows.push(row);
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
    excluded: canViewCosts ? excludedRows : excludedRows.map(redactExcluded),
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
    excluded: buyList.excluded.map(redactExcluded).sort(byUrgencyCostFree),
    totalCostKes: null,
  };
}

/** Recompute the mean-cover arithmetic; keep it only when the total lands on the
 *  stored quantity (policy-driven rules and post-run stock drift both disqualify —
 *  a breakdown that doesn't sum to the shown number is worse than none). */
function buildExplain(
  p: {
    regime: string | null;
    finalForecast30d: number;
    safetyStock: number;
    product: {
      currentStock: number;
      onOrder: number;
      leadTimeDays: number | null;
      supplier: { leadTimeAvgDays: number | null; leadTimeStdDays: number | null } | null;
    };
  },
  storedQty: number
): QtyExplanation | null {
  if (p.regime === "min_max") return null;
  const explain = explainQty({
    finalForecast30d: p.finalForecast30d,
    safetyStock: p.safetyStock,
    currentStock: p.product.currentStock,
    onOrder: p.product.onOrder,
    coverDays: coverDaysFor(p.product, p.product.supplier),
  });
  return explain.recommendedQty === storedQty ? explain : null;
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
  /** Criticals are non-negotiable: a budget below their cost overflows by this much. */
  overBudgetKes: number | null;
  /** True when the split was withheld from a money-blind caller: the three row
   *  lists are empty and every figure is null, because the split itself reads
   *  costs out. Absent otherwise. Consumers should say so rather than render an
   *  empty plan. */
  withheld?: boolean;
};

/**
 * Split the buy list against a cash cap. Priority: urgency first, then the
 * revenue at risk, then how soon the stockout lands — the budget goes where it
 * earns most. Criticals are always funded (overflow is surfaced, not hidden).
 *
 * Expects an unredacted list (real costs) — callers acting for a money-blind
 * member fetch with costs visible, split, then `redactBudgetSplit` the result.
 */
export function splitByBudget(rows: BuyListRow[], budgetKes: number): BudgetSplit {
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

  const { selected, deferred, usedKes } = allocateByBudget(scored, budgetKes);
  const deferredRows = deferred.map((s) => s.row);

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

/**
 * Set (or replace) this tenant's owner override of the recommended order
 * quantity for a product. Upsert on the (tenantId, productId) unique — one
 * standing override per product, updated in place. RLS-scoped end to end: the
 * tenant client can only reach its own rows, and the WITH CHECK policy rejects
 * any write that names a foreign tenant.
 */
export async function upsertPlanOverride(
  tenantId: string,
  input: PlanOverrideInput
): Promise<void> {
  const qty = Math.round(input.qty);
  const db = prismaForTenant(tenantId);
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
