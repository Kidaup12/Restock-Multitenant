import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { getDeadStockByMonth } from "@/lib/data/insights";

/**
 * Dead stock by month.
 *
 * Monthly rather than weekly because it is a WINDOW measure: stock held with no
 * sale in the last N days. Sampled weekly it moves mostly with the window
 * filling rather than with anything the shop did, which reads as a trend and is
 * not one. A month is longer than that noise.
 *
 * The class split is the part worth acting on. A hundred dead C-lines is a
 * tidy-up; one dead A-line is a bestseller nobody is buying any more, and the
 * total on its own hides that entirely.
 */

const monthLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

export async function DeadStockMonths({
  tenantId,
  canViewCosts,
}: {
  tenantId: string;
  canViewCosts: boolean;
}) {
  const { months, windowDays, trackingSince } = await getDeadStockByMonth(tenantId, {
    months: 6,
    canViewCosts,
  });

  if (months.length === 0) {
    return (
      <Card>
        <CardHeader title="Dead stock · by month" />
        <CardContent className="pt-3">
          <EmptyState
            title="Not enough recorded months yet"
            description={
              trackingSince
                ? `Shelf levels have been recorded since ${monthLabel(trackingSince)}. A month needs at least one recorded day before it can be measured.`
                : "Shelf levels are recorded nightly. Once a month is on record, it appears here."
            }
          />
        </CardContent>
      </Card>
    );
  }

  const latest = months[months.length - 1]!;
  const previous = months.length > 1 ? months[months.length - 2] : null;
  // Only stated when there is a previous month to compare against — a single
  // month has no direction, and "steady" would be a claim about nothing.
  const direction =
    previous == null
      ? null
      : latest.skus < previous.skus
        ? "down"
        : latest.skus > previous.skus
          ? "up"
          : "flat";

  return (
    <Card>
      <CardHeader
        title="Dead stock · by month"
        subtitle={`Stock held with no sale in the last ${windowDays} days. Measured monthly — its real pace; a weekly figure mostly shows the window filling.`}
        action={
          direction && (
            <Badge tone={direction === "down" ? "positive" : direction === "up" ? "negative" : "neutral"}>
              {direction === "down" ? "↓ trending down" : direction === "up" ? "↑ trending up" : "level"}
            </Badge>
          )
        }
      />
      <CardContent className="pt-3">
        <div className="overflow-x-auto">
          <div className="flex min-w-full gap-3">
            {months.map((m) => (
              <div
                key={m.monthStart.toISOString()}
                className="min-w-44 flex-1 rounded-lg border border-edge p-4"
              >
                <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  {monthLabel(m.monthStart)}
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="font-mono text-2xl font-semibold text-ink">{m.skus}</span>
                  <span className="text-xs text-ink-muted">SKUs</span>
                </div>
                <div className="mt-1 text-sm text-ink-muted">
                  <CostValue amount={m.costKes} canViewCosts={canViewCosts} compact /> at cost
                </div>
                {/* A dead A-line matters more than a hundred dead C-lines. */}
                <div className="mt-2 font-mono text-xs text-ink-faint">
                  A {m.byClass.a} · B {m.byClass.b} · C {m.byClass.c}
                  {m.byClass.unrated > 0 && ` · unrated ${m.byClass.unrated}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
