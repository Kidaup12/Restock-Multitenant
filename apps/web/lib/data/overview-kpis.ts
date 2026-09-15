import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { getCatalogueMetrics } from "@/lib/metrics";
import { deltaPercent } from "@/lib/data/delta-percent";
import { getTodayMetrics } from "./today";

/**
 * The Reports Overview KPI row — the four headline figures that sit above the
 * rest of the report: last-month revenue and how it moved, capital tied up in
 * stock, revenue at risk from near-empty shelves, and the ABC mix.
 *
 * This screen defines NO metric of its own. Revenue and its month-on-month
 * delta come from getTodayMetrics (the same 30/prior-30 windows Today and the
 * revenue chart use); capital tied up, the ABC mix and the at-risk estimate are
 * read off getCatalogueMetrics — the shared metric contract — so this row can
 * never disagree with the Stock, Today or Insights screens about the same
 * number.
 *
 * Cost fields are redacted here, not at render: the capital figure is built on
 * the real numbers, then nulled on the way out when the caller can't view costs,
 * so a money-blind member's payload never carries it. Revenue is a sales figure
 * and stays visible, and the "at retail" capital figure is price × on-hand — a
 * sales figure too — so it stays visible as the money-blind fallback the tile
 * can show instead.
 */

/** Cover below this many days, with a real run rate, is a shelf about to empty —
 *  the window the at-risk estimate sizes the loss over. Deliberately short: this
 *  is "what the next week could lose", not the plan's lead-time horizon. */
export const REVENUE_AT_RISK_HORIZON_DAYS = 7;

/** Below this rate the engine's cover is the "effectively forever" sentinel, so
 *  a product with no real velocity never counts as at risk (matches the epsilon
 *  the insights loaders use). */
const NO_RATE_EPSILON = 0.0001;

export type OverviewKpis = {
  /** Sum of SalesHistory.revenueKes over the trailing 30 days — a sales figure,
   *  visible to every role. */
  lastMonthRevenueKes: number;
  /** Whole-percent change against the 30 days before that. Null when there is no
   *  prior period to compare against. */
  momPercent: number | null;
  /** Which way the delta points, or "flat" at exactly no change. "up"/"down"
   *  drive the tile's arrow; kept separate from the sign so the tile doesn't
   *  have to re-derive it. */
  momDirection: "up" | "down" | "flat";
  /** Σ money-at-rest (cost × sellable on-hand) across the buyable catalogue.
   *  Null for a money-blind caller. */
  capitalAtCostKes: number | null;
  /** Σ price × sellable on-hand across the same catalogue — a sales figure, so
   *  it stays visible to every role and is the money-blind tile's fallback. */
  capitalAtRetailKes: number;
  /** Estimated sales the next 7 days could miss across shelves with under 7 days
   *  of cover and a real run rate: Σ runRate × price × 7. An ESTIMATE — a
   *  stockout's true lost demand is unknowable, so run-rate × horizon is the
   *  honest proxy, the same rate the buy list sizes on. A sales figure, shown to
   *  every role. */
  revenueAtRisk7dKes: number;
  /** How many products fed that estimate. */
  revenueAtRiskCount: number;
  /** The catalogue split by ABC class. Unrated products (the nightly run has not
   *  classified them yet) are counted separately, never folded into C. */
  abcMix: { a: number; b: number; c: number; unrated: number };
};

/**
 * The four headline figures in one pass. Reuses getTodayMetrics for the revenue
 * pair and getCatalogueMetrics for the per-product rate/cover/ABC/money-at-rest,
 * so nothing here is a second producer for a number another screen already owns.
 */
export async function getOverviewKpis(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<OverviewKpis> {
  const db = prismaForTenant(tenantId);

  const [today, metrics, products] = await Promise.all([
    getTodayMetrics(tenantId, { canViewCosts }),
    getCatalogueMetrics(tenantId),
    db.product.findMany({
      where: { ...BUYABLE_PRODUCT_WHERE },
      select: { id: true, priceKes: true },
    }),
  ]);

  let capitalAtCost = 0;
  let capitalAtRetail = 0;
  let revenueAtRisk = 0;
  let revenueAtRiskCount = 0;
  const abcMix = { a: 0, b: 0, c: 0, unrated: 0 };

  // Walk the buyable catalogue only — the same scope Today's tiles count over —
  // and read every per-product figure off the shared metric map so the capital,
  // the ABC mix and the at-risk estimate all agree with the rest of the app.
  for (const p of products) {
    const m = metrics.get(p.id);
    if (!m) continue;

    capitalAtCost += m.moneyAtRestKes;
    capitalAtRetail += p.priceKes * Math.max(0, m.sellableOnHand);

    // A shelf about to empty: real velocity and under a week of cover. The loss
    // is sized from the run rate over the horizon, not from what the product
    // managed to sell — the reference's revenue-at-risk figure does the same.
    if (m.runRate > NO_RATE_EPSILON && m.coverDays < REVENUE_AT_RISK_HORIZON_DAYS) {
      revenueAtRisk += m.runRate * p.priceKes * REVENUE_AT_RISK_HORIZON_DAYS;
      revenueAtRiskCount += 1;
    }

    if (m.abc === "A") abcMix.a += 1;
    else if (m.abc === "B") abcMix.b += 1;
    else if (m.abc === "C") abcMix.c += 1;
    else abcMix.unrated += 1;
  }

  const momPercent = deltaPercent(today.revenue30dKes, today.revenuePrev30dKes);
  const momDirection: OverviewKpis["momDirection"] =
    momPercent == null || momPercent === 0 ? "flat" : momPercent > 0 ? "up" : "down";

  return {
    lastMonthRevenueKes: today.revenue30dKes,
    momPercent,
    momDirection,
    // Built on the real total, nulled on the way out — the same redaction idiom
    // the other cost-bearing getters use. The retail figure is a sales number
    // and stays for every role.
    capitalAtCostKes: canViewCosts ? Math.round(capitalAtCost) : null,
    capitalAtRetailKes: Math.round(capitalAtRetail),
    revenueAtRisk7dKes: Math.round(revenueAtRisk),
    revenueAtRiskCount,
    abcMix,
  };
}
