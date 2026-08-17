
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { StatTile, type StatDelta } from "@/components/ui/stat-tile";
import { getTodayMetrics } from "@/lib/data/today";
import { deltaPercent } from "@/lib/data/delta-percent";

function revenueDelta(current: number, prior: number): StatDelta {
  // Same helper the chart beneath uses — the two used to round differently and
  // printed "-14.9%" beside "-15%".
  const rounded = deltaPercent(current, prior);
  if (rounded === null) return { label: "No prior-period sales", tone: "neutral" };
  if (rounded === 0) return { label: "Flat vs prior 30 days", tone: "neutral" };
  return {
    label: `${rounded > 0 ? "+" : ""}${rounded}% vs prior 30 days`,
    tone: rounded > 0 ? "positive" : "negative",
    direction: rounded > 0 ? "up" : "down",
  };
}

export async function MetricsTiles({
  tenantId,
  canViewCosts = true,
}: {
  tenantId: string;
  canViewCosts?: boolean;
}) {
  // canViewCosts flows into the query: cost fields come back null for a
  // money-blind member, so the figures never reach the payload.
  const m = await getTodayMetrics(tenantId, { canViewCosts });

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label="Revenue, 30 days"
        value={<CostValue amount={m.revenue30dKes} compact />}
        delta={revenueDelta(m.revenue30dKes, m.revenuePrev30dKes)}
      />
      <StatTile
        label="Tracked products"
        value={formatNumber(m.trackedProducts)}
        delta={{ label: "Active in catalogue", tone: "neutral" }}
      />
      <StatTile
        label="Stockouts"
        value={formatNumber(m.stockedOutProducts)}
        delta={
          m.stockedOutProducts > 0
            ? { label: "Zero on hand right now", tone: "negative", direction: "up" }
            : { label: "Everything in stock", tone: "positive" }
        }
      />
      <StatTile
        label="Dead stock"
        value={<CostValue amount={m.deadStock.costKes} canViewCosts={canViewCosts} compact />}
        delta={{
          label: `${m.deadStock.skus} SKUs, ${m.deadStock.windowDays}+ days idle`,
          tone: "neutral",
        }}
      />
    </div>
  );
}
