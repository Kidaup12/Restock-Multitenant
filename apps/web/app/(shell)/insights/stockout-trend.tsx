import { getStockoutTrend } from "@/lib/data/insights";
import { ChartIcon } from "@/components/icons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatNumber } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";

const weekLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const dateLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Weeks of history before a trend line says anything a shop owner should act on. */
const WEEKS_BEFORE_A_TREND = 4;

export async function StockoutTrend({ tenantId }: { tenantId: string }) {
  const { weeks, trackingSince } = await getStockoutTrend(tenantId);

  if (weeks.length < 2) {
    const readyOn =
      trackingSince &&
      dateLabel(new Date(trackingSince.getTime() + WEEKS_BEFORE_A_TREND * 7 * 86_400_000));
    return (
      <Card data-tour="insights-trend">
        <CardHeader title="Empty shelves, week by week" />
        <CardContent>
          <EmptyState
            icon={<ChartIcon />}
            title={trackingSince ? "Still building the picture" : "Not tracking yet"}
            description={
              trackingSince
                ? `We started recording shelf levels on ${dateLabel(trackingSince)}. There'll be a trend worth reading from about ${readyOn}.`
                : "We record what's on the shelf once a night. The first full week of that history is what this chart needs — it starts as soon as the nightly check runs."
            }
          />
        </CardContent>
      </Card>
    );
  }

  const peak = Math.max(1, ...weeks.map((w) => w.ratePct));
  const latest = weeks[weeks.length - 1]!;
  const previous = weeks[weeks.length - 2]!;
  const change = Math.round((latest.ratePct - previous.ratePct) * 10) / 10;

  return (
    <Card data-tour="insights-trend">
      <CardHeader
        title="Empty shelves, week by week"
        subtitle={
          change === 0
            ? "Holding steady against last week"
            : change < 0
              ? `Down ${Math.abs(change)} points on last week`
              : `Up ${change} points on last week`
        }
      />
      <CardContent>
        <div className="flex h-32 items-end gap-2">
          {weeks.map((week) => (
            <div key={week.weekStart.getTime()} className="flex flex-1 flex-col items-center gap-1.5">
              <span className="font-mono text-xs tabular-nums text-ink-muted">{week.ratePct}%</span>
              <div className="flex h-full w-full items-end">
                <div
                  className="w-full rounded-t bg-accent"
                  style={{ height: `${Math.max(2, (week.ratePct / peak) * 100)}%` }}
                  role="img"
                  aria-label={`Week of ${weekLabel(week.weekStart)}: ${week.ratePct}% of shelf-days empty`}
                  title={`${formatNumber(week.emptyProductDays)} empty of ${formatNumber(week.observedProductDays)} product-days`}
                />
              </div>
              <span className="text-xs text-ink-muted">{weekLabel(week.weekStart)}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-ink-muted">
          Share of the products we tracked that had nothing on the shelf, counted once a night. A
          week is only shown once there are enough nights in it to mean something.
        </p>
      </CardContent>
    </Card>
  );
}
