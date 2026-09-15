import { CostValue } from "@/components/ui/cost-value";
import { StatTile } from "@/components/ui/stat-tile";
import { formatMoney, formatNumber } from "@/lib/money";
import {
  getOverviewKpis,
  REVENUE_AT_RISK_HORIZON_DAYS,
} from "@/lib/data/overview-kpis";

/**
 * The Reports Overview KPI row: four headline tiles above the rest of the
 * report — last-month revenue and how it moved, capital tied up in stock,
 * revenue at risk from near-empty shelves, and the ABC mix.
 *
 * A server component: it awaits the loader and hands each figure to a StatTile,
 * the house tile. The two money tiles pass their figure through CostValue, which
 * masks it for a money-blind member; the capital tile leads with the cost figure
 * for a caller who may see it and falls back to the at-retail figure (a sales
 * number) for one who may not, so the tile still carries a real answer either
 * way rather than a row of dots.
 *
 * `currency` comes from the page's membership because the plain-string hints
 * (the "at retail" line, the at-risk sub-line) format money outside React
 * context, where CostValue's context read is unavailable.
 */
export async function OverviewKpis({
  tenantId,
  currency,
  canViewCosts,
}: {
  tenantId: string;
  currency: string;
  canViewCosts: boolean;
}) {
  const kpis = await getOverviewKpis(tenantId, { canViewCosts });

  const {
    lastMonthRevenueKes,
    momPercent,
    momDirection,
    capitalAtCostKes,
    capitalAtRetailKes,
    revenueAtRisk7dKes,
    revenueAtRiskCount,
    abcMix,
  } = kpis;

  return (
    <div
      className="grid grid-cols-2 gap-4 lg:grid-cols-4"
      data-tour="insights-overview-kpis"
    >
      <StatTile
        label="Last-month revenue"
        value={<CostValue amount={lastMonthRevenueKes} compact />}
        delta={
          momPercent == null
            ? { label: "no prior month to compare", tone: "neutral" }
            : {
                label: `${momPercent > 0 ? "+" : ""}${momPercent}% vs prior 30 days`,
                tone: momPercent > 0 ? "positive" : momPercent < 0 ? "negative" : "neutral",
                direction:
                  momDirection === "up" ? "up" : momDirection === "down" ? "down" : undefined,
              }
        }
      />

      <StatTile
        label="Capital tied up"
        // The cost figure leads for a reader allowed to see it; a money-blind
        // member gets the at-retail figure, which is a sales number they may
        // have, rather than a masked tile that says nothing.
        value={
          canViewCosts ? (
            <CostValue amount={capitalAtCostKes} canViewCosts={canViewCosts} compact />
          ) : (
            formatMoney(capitalAtRetailKes, currency, { compact: true })
          )
        }
        delta={{
          label: canViewCosts
            ? `${formatMoney(capitalAtRetailKes, currency, { compact: true })} at retail`
            : "at retail value",
          tone: "neutral",
        }}
      />

      <StatTile
        label="Revenue at risk"
        value={<CostValue amount={revenueAtRisk7dKes} compact />}
        valueTone={revenueAtRisk7dKes > 0 ? "warning" : "default"}
        delta={{
          label:
            revenueAtRiskCount > 0
              ? `next ${REVENUE_AT_RISK_HORIZON_DAYS} days · ${formatNumber(revenueAtRiskCount)} near stockout`
              : `next ${REVENUE_AT_RISK_HORIZON_DAYS} days · nothing near stockout`,
          tone: revenueAtRisk7dKes > 0 ? "negative" : "positive",
        }}
      />

      <StatTile
        label="ABC mix"
        value={
          <span className="tabular-nums">
            {formatNumber(abcMix.a)}
            <span className="text-ink-faint">·</span>
            {formatNumber(abcMix.b)}
            <span className="text-ink-faint">·</span>
            {formatNumber(abcMix.c)}
          </span>
        }
        delta={{
          label:
            abcMix.unrated > 0
              ? `A·B·C · ${formatNumber(abcMix.unrated)} unrated`
              : "A·B·C classes",
          tone: "neutral",
        }}
      />
    </div>
  );
}
