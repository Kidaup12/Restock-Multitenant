import { getImpact } from "@/lib/data/insights";
import { BulbIcon } from "@/components/icons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * "Has this made a difference?" — the two numbers a shop owner actually judges
 * by, first measurable week against the latest: how often shelves are empty, and
 * how many products are sitting there not selling.
 *
 * No shillings figure, on purpose. A money claim needs a counterfactual nothing
 * here records, and whatever this card prints is what the owner repeats.
 */

const dateLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function Measure({
  label,
  start,
  now,
  change,
  unit,
  betterWhenLower = true,
}: {
  label: string;
  start: number;
  now: number;
  change: number;
  unit: "pct" | "skus";
  betterWhenLower?: boolean;
}) {
  const fmt = (n: number) => (unit === "pct" ? `${n}%` : String(n));
  const improved = betterWhenLower ? change < 0 : change > 0;
  const tone = change === 0 ? "text-ink-muted" : improved ? "text-positive" : "text-negative";
  const word =
    change === 0
      ? "no change"
      : `${improved ? "down" : "up"} ${unit === "pct" ? `${Math.abs(change)} points` : `${Math.abs(change)}`}`;

  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="font-mono text-2xl tabular-nums text-ink">{fmt(now)}</p>
      <p className={`text-sm ${tone}`}>
        {word}
        <span className="text-ink-muted"> from {fmt(start)}</span>
      </p>
    </div>
  );
}

export async function ImpactCard({ tenantId }: { tenantId: string }) {
  const impact = await getImpact(tenantId);

  if (impact.reason === "no_order_yet") {
    return (
      <Card>
        <CardHeader title="Has this made a difference?" />
        <CardContent>
          <EmptyState
            icon={<BulbIcon />}
            title="Nothing to measure yet"
            description="We start counting from your first purchase order — before that there's nothing here to take credit for. Send one and this fills in."
          />
        </CardContent>
      </Card>
    );
  }

  if (impact.reason === "too_early" || !impact.emptyShelfPct) {
    return (
      <Card>
        <CardHeader title="Has this made a difference?" />
        <CardContent>
          <EmptyState
            icon={<BulbIcon />}
            title="Still building the picture"
            description={
              impact.trackingSince
                ? `We've been recording shelf levels since ${dateLabel(impact.trackingSince)}${impact.since ? `, and measuring from your first order on ${dateLabel(impact.since)}` : ""}. Two full weeks of both is what this needs.`
                : "We record what's on the shelf once a night. Two full weeks of that is what this needs."
            }
          />
        </CardContent>
      </Card>
    );
  }

  const { emptyShelfPct, deadStockSkus } = impact;

  return (
    <Card>
      <CardHeader
        title="Has this made a difference?"
        subtitle={`Week of ${dateLabel(emptyShelfPct.startWeek)} against week of ${dateLabel(emptyShelfPct.nowWeek)}${impact.since ? `, measured since your first order on ${dateLabel(impact.since)}` : ""}`}
      />
      <CardContent>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Measure
            label="Empty shelves"
            start={emptyShelfPct.start}
            now={emptyShelfPct.now}
            change={emptyShelfPct.change}
            unit="pct"
          />
          {deadStockSkus ? (
            <Measure
              label={`Not sold in ${impact.deadStockWindowDays} days`}
              start={deadStockSkus.start}
              now={deadStockSkus.now}
              change={deadStockSkus.change}
              unit="skus"
            />
          ) : (
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-ink-muted">
                Not sold in {impact.deadStockWindowDays} days
              </p>
              <p className="font-mono text-2xl tabular-nums text-ink-muted">—</p>
              <p className="text-sm text-ink-muted">No shelf record for one of those weeks.</p>
            </div>
          )}
        </div>
        <p className="mt-4 text-xs text-ink-muted">
          Both counted from the nightly shelf check. A week is only used once it has enough nights
          in it to mean something — and a number that went the wrong way is shown as it is.
        </p>
      </CardContent>
    </Card>
  );
}
