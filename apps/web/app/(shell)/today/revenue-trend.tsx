import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/money";
import { getSalesComparison, type SalesDay } from "@/lib/data/sales";

/** Revenue sparkline over the trailing 30 days, with the prior 30 as the
 *  comparison badge. Same visual as the design mock, driven by real series. */

const chart = { width: 560, height: 120, pad: 8 };

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function sparkline(series: SalesDay[]) {
  const values = series.map((s) => s.revenueKes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => {
    const x = series.length > 1 ? (i / (series.length - 1)) * chart.width : chart.width;
    const y = chart.height - chart.pad - ((v - min) / span) * (chart.height - 2 * chart.pad);
    return `${x},${y}`;
  });
  const line = points.join(" ");
  return {
    line,
    area: `${line} ${chart.width},${chart.height} 0,${chart.height}`,
    endTop: `${(Number(points[points.length - 1]!.split(",")[1]) / chart.height) * 100}%`,
  };
}

/** `currency` comes from the page's membership: the subtitle is a plain string,
 *  so it can't read the workspace currency from context the way CostValue does. */
export async function RevenueTrend({
  tenantId,
  currency,
}: {
  tenantId: string;
  currency: string;
}) {
  const comparison = await getSalesComparison(tenantId, 30);
  const { series, priorRevenueKes: priorTotal } = comparison;

  if (series.length === 0) {
    return (
      <Card>
        <CardHeader title="Sales, last 30 days" subtitle="No sales recorded yet" />
        <CardContent>
          <EmptyState
            title="No sales in the last 30 days"
            description="Once sales sync in, the daily revenue trend appears here."
          />
        </CardContent>
      </Card>
    );
  }

  const total = comparison.revenueKes;
  const perDay = total / 30;
  const deltaPct = priorTotal > 0 ? Math.round(((total - priorTotal) / priorTotal) * 100) : null;
  const spark = sparkline(series);

  return (
    <Card>
      <CardHeader
        title="Sales, last 30 days"
        subtitle={`${formatMoney(total, currency, { compact: true })} total · ${formatMoney(perDay, currency, { compact: true })}/day average`}
        action={
          deltaPct !== null ? (
            <Badge tone={deltaPct >= 0 ? "positive" : "negative"}>
              {deltaPct >= 0 ? "+" : ""}
              {deltaPct}% vs prior 30 days
            </Badge>
          ) : undefined
        }
      />
      <CardContent>
        <div>
          <div className="relative border-b border-edge">
            <svg
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              preserveAspectRatio="none"
              aria-label="Daily revenue trend, last 30 days"
              role="img"
              className="h-28 w-full"
            >
              <defs>
                <linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: "var(--accent)", stopOpacity: 0.25 }} />
                  <stop offset="100%" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              <polygon points={spark.area} fill="url(#sales-fill)" />
              <polyline
                points={spark.line}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="stroke-accent"
              />
            </svg>
            <span
              className="absolute right-0 size-2.5 -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-surface bg-accent"
              style={{ top: spark.endTop }}
            />
          </div>
          <div className="mt-3 flex justify-between text-xs text-ink-muted">
            <span>{dayLabel(series[0]!.date)}</span>
            <span>{dayLabel(series[series.length - 1]!.date)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
