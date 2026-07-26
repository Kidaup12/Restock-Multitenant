import {
  ACCURACY_MIN_HISTORY_DAYS,
  getAccuracyScorecard,
  getPlanAdherence,
  type AccuracyCheck,
} from "@/lib/data/insights";
import { BulbIcon, ClipboardIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatNumber } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";

const dateLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const monthLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

/** The lean word in a sentence a shop owner would say. Never a percentage: the
 *  number that means something here is units, said against sold. */
const LEAN_COPY: Record<AccuracyCheck["leans"], { text: string; tone: "positive" | "warning" }> = {
  over: { text: "We were on the high side", tone: "warning" },
  under: { text: "We were on the low side", tone: "warning" },
  even: { text: "That's about right", tone: "positive" },
};

/**
 * Why there is no grade yet, in the shop's terms. Once the history bar is met
 * the wait is the monthly check, not the history — promising a date that has
 * already passed reads as broken.
 */
export function noGradeYet(firstSaleAt: Date | null, now: Date = new Date()): string {
  if (!firstSaleAt) {
    return `The check replays past forecasts against real sales. It can run once you have about ${ACCURACY_MIN_HISTORY_DAYS} days of sales on record.`;
  }
  const due = firstSaleAt.getTime() + ACCURACY_MIN_HISTORY_DAYS * 86_400_000;
  if (due > now.getTime()) {
    return `The check replays past forecasts against real sales, so it needs about ${ACCURACY_MIN_HISTORY_DAYS} days of history. Yours is due around ${dateLabel(new Date(due))}.`;
  }
  return "You have enough sales history for the check now — it runs on the first of each month, and the result lands here.";
}

function AccuracyBars({ history }: { history: AccuracyCheck[] }) {
  const peak = Math.max(1, ...history.flatMap((h) => [h.saidUnits, h.happenedUnits]));
  return (
    <div className="mt-5 flex h-28 items-end gap-4">
      {history.map((check) => (
        <div key={check.runDate.getTime()} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex h-full w-full items-end justify-center gap-1">
            <div
              className="w-1/3 rounded-t bg-accent"
              style={{ height: `${Math.max(2, (check.saidUnits / peak) * 100)}%` }}
              role="img"
              aria-label={`We said ${Math.round(check.saidUnits)} units`}
              title={`We said ${formatNumber(check.saidUnits)} units`}
            />
            <div
              className="w-1/3 rounded-t bg-accent opacity-55"
              style={{ height: `${Math.max(2, (check.happenedUnits / peak) * 100)}%` }}
              role="img"
              aria-label={`You sold ${Math.round(check.happenedUnits)} units`}
              title={`You sold ${formatNumber(check.happenedUnits)} units`}
            />
          </div>
          <span className="text-xs text-ink-muted">{monthLabel(check.runDate)}</span>
        </div>
      ))}
    </div>
  );
}

export async function ForecastScorecard({ tenantId }: { tenantId: string }) {
  const [scorecard, adherence] = await Promise.all([
    getAccuracyScorecard(tenantId),
    getPlanAdherence(tenantId),
  ]);
  const latest = scorecard.latest;

  return (
    <div className="space-y-6">
      <Card data-tour="insights-accuracy">
        <CardHeader
          title="How close we've been"
          subtitle="We replay the forecast against what you actually sold, once a month"
        />
        <CardContent>
          {!latest ? (
            <EmptyState
              icon={<BulbIcon />}
              title="We haven't graded ourselves yet"
              description={noGradeYet(scorecard.firstSaleAt)}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
                <div>
                  <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">
                    We said
                  </div>
                  <div className="font-mono text-3xl font-semibold tabular-nums text-ink-strong">
                    {formatNumber(latest.saidUnits)}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">
                    You sold
                  </div>
                  <div className="font-mono text-3xl font-semibold tabular-nums text-ink-strong">
                    {formatNumber(latest.happenedUnits)}
                  </div>
                </div>
                {latest.sampleSize > 1 && (
                  <Badge tone={LEAN_COPY[latest.leans].tone}>{LEAN_COPY[latest.leans].text}</Badge>
                )}
              </div>
              <p className="mt-3 text-xs text-ink-muted">
                Checked {dateLabel(latest.runDate)} across {formatNumber(latest.sampleSize)}{" "}
                product{latest.sampleSize === 1 ? "" : "s"}
                {latest.sampleSize === 1 && " — one check so far, too thin to read a pattern"}.
              </p>
              {scorecard.history.length >= 2 && <AccuracyBars history={scorecard.history} />}
            </>
          )}
        </CardContent>
      </Card>

      <Card data-tour="insights-adherence">
        <CardHeader
          title="Did you act on it?"
          subtitle={`Recommendations from the last ${adherence.windowDays} days`}
        />
        <CardContent>
          {!adherence.hasHistory ? (
            <EmptyState
              icon={<ClipboardIcon />}
              title="Nothing to compare yet"
              description="Once the forecast has asked you to buy something and you have raised an order, this shows how closely the two matched."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
                <div>
                  <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">
                    Acted on
                  </div>
                  <div className="font-mono text-3xl font-semibold tabular-nums text-ink-strong">
                    {formatNumber(adherence.actedProducts)}
                    <span className="text-lg text-ink-muted">
                      {" "}
                      / {formatNumber(adherence.askedProducts)}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-ink-secondary">
                  products we asked you to buy, that you went on to order
                </p>
              </div>

              {adherence.linesCompared > 0 ? (
                <div className="mt-5 space-y-2">
                  <p className="text-sm text-ink-secondary">
                    Of the {formatNumber(adherence.linesCompared)} order line
                    {adherence.linesCompared === 1 ? "" : "s"} you built here that carried a
                    recommendation:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="neutral">
                      {formatNumber(adherence.boughtAsAsked)} about what we said
                    </Badge>
                    <Badge tone="warning">{formatNumber(adherence.boughtLess)} bought less</Badge>
                    <Badge tone="accent">{formatNumber(adherence.boughtMore)} bought more</Badge>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-ink-muted">
                  No order lines raised here yet carried a recommendation, so there is nothing to
                  compare quantities against. Orders cut outside the app aren&apos;t counted.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
