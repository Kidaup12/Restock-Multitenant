import {
  ACCURACY_MIN_HISTORY_DAYS,
  getAccuracyScorecard,
  getAsShownScorecard,
  getPlanAdherence,
  type AccuracyCheck,
} from "@/lib/data/insights";
import { BulbIcon, ClipboardIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatNumber } from "@/lib/money";
import { EmptyState } from "@/components/ui/empty-state";
import { RunBacktestButton } from "./run-backtest-button";
import { OnboardingAuditButton } from "./onboarding-audit-button";

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
export function noGradeYet(
  firstSaleAt: Date | null,
  lastSaleAt: Date | null,
  now: Date = new Date()
): string {
  if (!firstSaleAt || !lastSaleAt) {
    return `The check replays past forecasts against real sales. It can run once you have about ${ACCURACY_MIN_HISTORY_DAYS} days of sales on record.`;
  }

  // The SPAN of sales, not the time since the first one. A shop whose sales
  // stopped a fortnight ago gains nothing by waiting, and the old wording told
  // exactly such a store it had enough — 68 days had passed since its first
  // sale, but only 54 days separated its first sale from its last, and the
  // check needs 59. It then declined, on the same card that had just promised it.
  const spanDays = Math.floor((lastSaleAt.getTime() - firstSaleAt.getTime()) / 86_400_000);
  if (spanDays >= ACCURACY_MIN_HISTORY_DAYS) {
    return "You have enough sales history for the check now — it runs on the first of each month, or press Check now.";
  }

  // What is missing is days OF SALES, not days on the calendar. Naming a due
  // date would be a promise that selling continues, and the shop this was found
  // on had stopped: its date would have come and gone with nothing to score.
  const shortBy = ACCURACY_MIN_HISTORY_DAYS - spanDays;
  const need = `The check replays past forecasts against real sales, so it needs about ${ACCURACY_MIN_HISTORY_DAYS} days of them from first to last. Yours covers ${spanDays}, so it is about ${shortBy} ${shortBy === 1 ? "day" : "days"} of selling short.`;

  const quietFor = Math.floor((now.getTime() - lastSaleAt.getTime()) / 86_400_000);
  if (quietFor >= 14) {
    return `${need} Nothing has come in since ${dateLabel(lastSaleAt)}, so that gap closes when selling resumes rather than with time passing.`;
  }
  return need;
}

function AccuracyBars({ history }: { history: AccuracyCheck[] }) {
  const peak = Math.max(1, ...history.flatMap((h) => [h.saidUnits, h.happenedUnits]));
  return (
    <div className="mt-5 flex h-28 items-end gap-4">
      {history.map((check) => (
        <div key={check.runDate.getTime()} className="flex h-full flex-1 flex-col items-center gap-1.5">
          {/* flex-1, not h-full: the row aligns to items-end, so a percentage
              height here resolves against a column the label alone has sized —
              which is zero, and draws no bars at all. */}
          <div className="flex w-full min-h-0 flex-1 items-end justify-center gap-1">
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

export async function ForecastScorecard({
  tenantId,
  canRunCheck,
}: {
  tenantId: string;
  /** Whether this reader may trigger the check. It writes a grade row, so it
   *  sits behind the same permission the route re-checks server-side. */
  canRunCheck: boolean;
}) {
  const [scorecard, asShown, adherence] = await Promise.all([
    getAccuracyScorecard(tenantId),
    getAsShownScorecard(tenantId),
    getPlanAdherence(tenantId),
  ]);
  const latest = scorecard.latest;
  const asShownLatest = asShown.latest;

  return (
    <div className="space-y-6">
      <Card data-tour="insights-accuracy">
        <CardHeader
          title="How close we've been"
          subtitle="We replay the forecast against what you actually sold, once a month"
          action={
            canRunCheck ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <OnboardingAuditButton canRun={canRunCheck} />
                <RunBacktestButton />
              </div>
            ) : undefined
          }
        />
        <CardContent>
          {!latest ? (
            <EmptyState
              icon={<BulbIcon />}
              title="We haven't graded ourselves yet"
              description={noGradeYet(scorecard.firstSaleAt, scorecard.lastSaleAt)}
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

      <Card data-tour="insights-as-shown">
        <CardHeader
          title="Was what we told you right?"
          subtitle="Scored against the buy list you actually saw, once its month has run"
        />
        <CardContent>
          {!asShownLatest ? (
            <EmptyState
              icon={<BulbIcon />}
              title="Nothing has finished its month yet"
              description="Each day's buy list is scored once the 30 days it covered have passed, so the first result appears a month after your first one. Unlike the check above, this one never changes afterwards — it grades the advice you were given, not what we would say now."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
                <div>
                  <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">
                    We said
                  </div>
                  <div className="font-mono text-3xl font-semibold tabular-nums text-ink-strong">
                    {formatNumber(asShownLatest.saidUnits)}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">
                    You sold
                  </div>
                  <div className="font-mono text-3xl font-semibold tabular-nums text-ink-strong">
                    {formatNumber(asShownLatest.happenedUnits)}
                  </div>
                </div>
                {asShownLatest.sampleSize > 1 && (
                  <Badge tone={LEAN_COPY[asShownLatest.leans].tone}>
                    {LEAN_COPY[asShownLatest.leans].text}
                  </Badge>
                )}
              </div>
              <p className="mt-3 text-xs text-ink-muted">
                Covering the 30 days from {dateLabel(asShownLatest.runDate)} across{" "}
                {formatNumber(asShownLatest.sampleSize)} product
                {asShownLatest.sampleSize === 1 ? "" : "s"}.
              </p>
              {asShown.history.length >= 2 && <AccuracyBars history={asShown.history} />}
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
