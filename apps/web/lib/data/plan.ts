import { prismaForTenant, prismaForTenantTx } from "@wezesha/db";
import {
  allocateByBudget,
  coverDaysFor,
  explainQty,
  leadDaysFor,
  plannableReason,
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

/** Horizon (days) for the "what deferring costs you" revenue-at-risk figure. */
const RISK_HORIZON_DAYS = 30;

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
  daysUntilStockout: number;
  /** Days left before ordering any later means a stockout: stockout minus lead time. */
  daysLeftToOrder: number;
  urgency: string;
  tier: BuyTier;
  recommendedQty: number;
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
};

export type BuyList = {
  forecastRunId: string;
  runDate: Date;
  /** Everything the run wants ordered, most urgent first. */
  rows: BuyListRow[];
  /** Total products covered by the run (for the "n of m" subtitle). */
  totalPredicted: number;
  /** Cost of ordering the whole list. Null when the caller can't view costs. */
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

function tierFor(urgency: string, daysLeftToOrder: number): BuyTier {
  if (urgency === "critical" || daysLeftToOrder <= 0) return "order_today";
  if (daysLeftToOrder <= 7) return "this_week";
  return "can_wait";
}

/** The latest run's buy list, or null when no forecast has run yet. Rows are
 *  built (and sorted) on full costs, then redacted, so ordering is identical
 *  whichever way the flag lands. */
export async function getBuyList(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
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
          supplier: { select: { name: true, leadTimeAvgDays: true, leadTimeStdDays: true } },
        },
      },
    },
  });

  const rows = predictions
    .map((p) => ({ ...p, qty: Math.round(p.recommendedQty) }))
    .filter((p) => p.qty > 0)
    .map((p): FullBuyListRow => {
      const product = p.product;
      const leadDays = leadDaysFor(product, product.supplier) ?? 0;
      const daysLeftToOrder = p.daysUntilStockout - leadDays;
      const stockoutDays = Math.max(0, RISK_HORIZON_DAYS - p.daysUntilStockout);
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
        daysUntilStockout: p.daysUntilStockout,
        daysLeftToOrder,
        urgency: p.urgency,
        tier: tierFor(p.urgency, daysLeftToOrder),
        recommendedQty: p.qty,
        unitCostKes: product.costKes,
        lineTotalKes: p.qty * product.costKes,
        priceKes: product.priceKes,
        reasoning: p.reasoning,
        explain: buildExplain(p, p.qty),
        qtySummary: buildQtySummary(p, p.qty),
        plannable: plannableReason(product),
        atRiskKes: Math.round((p.finalForecast30d / RISK_HORIZON_DAYS) * product.priceKes * stockoutDays),
      };
    })
    .sort(
      (a, b) =>
        (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9) ||
        a.daysUntilStockout - b.daysUntilStockout ||
        b.lineTotalKes - a.lineTotalKes
    );

  return {
    forecastRunId: latest.forecastRunId,
    runDate: latest.runDate,
    rows: canViewCosts ? rows : rows.map(redactRow),
    totalPredicted: predictions.length,
    totalCostKes: canViewCosts ? rows.reduce((sum, r) => sum + r.lineTotalKes, 0) : null,
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
    .sort(
      (a, b) =>
        (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9) ||
        (b.atRiskKes ?? 0) - (a.atRiskKes ?? 0) ||
        a.daysUntilStockout - b.daysUntilStockout
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

/** Null out every KES figure in a split for a money-blind caller — the item
 *  lists and counts survive, the money does not. */
export function redactBudgetSplit(split: BudgetSplit, canViewCosts: boolean): BudgetSplit {
  if (canViewCosts) return split;
  return {
    ...split,
    funded: split.funded.map(redactRow),
    deferred: split.deferred.map(redactRow),
    checkCost: split.checkCost.map(redactRow),
    fundedCostKes: null,
    deferredCostKes: null,
    deferredAtRiskKes: null,
    leftoverKes: null,
    overBudgetKes: null,
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
