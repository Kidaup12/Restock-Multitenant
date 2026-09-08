import { EmptyState } from "@/components/ui/empty-state";
import { getPeriodMetrics } from "@/lib/data/insights";
import type { AbcKey } from "@/lib/data/abc-lens";
import { PeriodTableView, type PeriodRowView } from "./period-table-view";

/**
 * Week-by-week metrics, fetched and formatted here.
 *
 * The dates become strings on this side of the boundary: the client view then
 * receives nothing but plain data, and the formatting stays with the rest of the
 * app's date handling rather than depending on the reader's locale.
 *
 * Newest week first — the question a shop asks of this table is "how are we
 * doing lately", not "how did we start".
 */

const weekLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export async function PeriodTable({
  tenantId,
  weeks,
  abc,
}: {
  tenantId: string;
  weeks: number;
  /** The class lens, applied to every column so they cannot disagree. */
  abc: AbcKey;
}) {
  const metrics = await getPeriodMetrics(tenantId, { weeks, abc });

  if (metrics.weeks.length === 0) {
    return (
      <EmptyState
        title="Not enough recorded weeks yet"
        description={
          metrics.trackingSince
            ? `Shelf levels have been recorded since ${weekLabel(metrics.trackingSince)}. A week needs most of its days recorded before it can be reported.`
            : "Shelf levels are recorded nightly. Once a few full weeks are on record, they'll be listed here."
        }
      />
    );
  }

  const rows: PeriodRowView[] = metrics.weeks
    .map((w) => ({
      key: w.weekStart.toISOString(),
      label: weekLabel(w.weekStart),
      emptyRatePct: w.emptyRatePct,
      emptyProductDays: w.emptyProductDays,
      observedProductDays: w.observedProductDays,
      daysCovered: w.daysCovered,
      unitsSold: w.unitsSold,
      culprits: w.culprits,
    }))
    .reverse();

  return <PeriodTableView rows={rows} />;
}
