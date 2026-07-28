import { BanknoteIcon, ChartIcon, TrendUpIcon } from "@/components/icons";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { StatTile, type StatDelta } from "@/components/ui/stat-tile";
import { getSalesComparison } from "@/lib/data/sales";

/** 30-day headline: revenue (with prior-30d delta), units, daily average. */
export async function SalesHeadline({ tenantId }: { tenantId: string }) {
  const { revenueKes, unitsSold, tradingDays, priorRevenueKes } = await getSalesComparison(
    tenantId,
    30
  );

  let delta: StatDelta = { label: "No prior-period sales", tone: "neutral" };
  if (priorRevenueKes > 0) {
    const pct = Math.round(((revenueKes - priorRevenueKes) / priorRevenueKes) * 100);
    delta = {
      label: `${pct >= 0 ? "+" : ""}${pct}% vs prior 30 days`,
      tone: pct > 0 ? "positive" : pct < 0 ? "negative" : "neutral",
      direction: pct > 0 ? "up" : pct < 0 ? "down" : undefined,
    };
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatTile
        label="Revenue, 30 days"
        value={<CostValue amount={revenueKes} compact />}
        delta={delta}
        icon={<BanknoteIcon />}
      />
      <StatTile
        label="Units sold, 30 days"
        value={formatNumber(unitsSold)}
        delta={{ label: `${tradingDays} trading days`, tone: "neutral" }}
        icon={<ChartIcon />}
      />
      <StatTile
        label="Daily average"
        value={<CostValue amount={revenueKes / 30} compact />}
        delta={{ label: `${formatNumber(unitsSold / 30)} units/day`, tone: "neutral" }}
        icon={<TrendUpIcon />}
      />
    </div>
  );
}
