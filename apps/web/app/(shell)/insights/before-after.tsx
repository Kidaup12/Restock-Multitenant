import { getImpact, type ImpactMeasure } from "@/lib/data/insights";

import { BulbIcon } from "@/components/icons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * "Before and after" — the TABLE cut of the same two numbers the impact card
 * shows as tiles: how often shelves are empty, and how many products are sitting
 * unsold. Before is the first measurable week after the shop's first order; Now
 * is the latest week.
 *
 * A drop is an improvement for BOTH rows — fewer empty shelves and fewer dead
 * SKUs are what the shop wants — so a negative change is coloured good and a
 * rise is coloured bad. No shillings figure: a money claim needs a
 * counterfactual nothing here records, same rule as the card.
 */

const monthLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/** The change cell: down is good for both measures, so a fall reads positive. */
function ChangeCell({
  change,
  unit,
}: {
  change: number;
  unit: "pct" | "skus";
}) {
  const improved = change < 0;
  const tone = change === 0 ? "text-ink-muted" : improved ? "text-positive" : "text-negative";
  const word =
    change === 0
      ? "no change"
      : `${improved ? "↓" : "↑"} ${Math.abs(change)}${unit === "pct" ? " pts" : ""}`;
  return <span className={`font-medium ${tone}`}>{word}</span>;
}

/** Format a measure value for display: percentages carry a %, counts are bare. */
const fmt = (n: number, unit: "pct" | "skus"): string => (unit === "pct" ? `${n}%` : String(n));

export async function BeforeAfter({ tenantId }: { tenantId: string }) {
  const impact = await getImpact(tenantId);

  if (impact.reason === "no_order_yet") {
    return (
      <Card>
        <CardHeader title="Before and after" />
        <CardContent>
          <EmptyState
            icon={<BulbIcon />}
            title="Nothing to compare yet"
            description="We start measuring from your first purchase order — before that there's no 'before'. Send one and this fills in."
          />
        </CardContent>
      </Card>
    );
  }

  if (impact.reason === "too_early" || !impact.emptyShelfPct) {
    return (
      <Card>
        <CardHeader title="Before and after" />
        <CardContent>
          <EmptyState
            icon={<BulbIcon />}
            title="Still building the picture"
            description={
              impact.trackingSince
                ? `We've been recording shelf levels since ${monthLabel(impact.trackingSince)}. Two full measurable weeks is what a before-and-after needs.`
                : "We record what's on the shelf once a night. Two full measurable weeks is what a before-and-after needs."
            }
          />
        </CardContent>
      </Card>
    );
  }

  const { emptyShelfPct, deadStockSkus } = impact;

  // One row per measure. Dead stock can be null when one of the two weeks has no
  // shelf record — it shows a friendly dash rather than a fabricated count.
  type Row = {
    label: string;
    measure: ImpactMeasure | null;
    unit: "pct" | "skus";
    absentNote: string;
  };
  const rows: Row[] = [
    {
      label: "Empty shelves",
      measure: emptyShelfPct,
      unit: "pct",
      absentNote: "No shelf record for one of those weeks.",
    },
    {
      label: `Dead-stock SKUs (${impact.deadStockWindowDays}d unsold)`,
      measure: deadStockSkus,
      unit: "skus",
      absentNote: "No shelf record for one of those weeks.",
    },
  ];

  return (
    <Card data-tour="insights-before-after">
      <CardHeader
        title="Before and after"
        subtitle={`Week of ${monthLabel(emptyShelfPct.startWeek)} against week of ${monthLabel(emptyShelfPct.nowWeek)}`}
      />
      <CardContent>
        <Table>
          <TableHeader>
            <TableHead>Measure</TableHead>
            <TableHead numeric>Before</TableHead>
            <TableHead numeric>Now</TableHead>
            <TableHead numeric>Change</TableHead>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell>
                  <span className="font-medium text-ink">{row.label}</span>
                </TableCell>
                {row.measure ? (
                  <>
                    <TableCell numeric>{fmt(row.measure.start, row.unit)}</TableCell>
                    <TableCell numeric>{fmt(row.measure.now, row.unit)}</TableCell>
                    <TableCell numeric>
                      <ChangeCell change={row.measure.change} unit={row.unit} />
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell numeric className="text-ink-faint">—</TableCell>
                    <TableCell numeric className="text-ink-faint">—</TableCell>
                    <TableCell numeric className="text-ink-muted">{row.absentNote}</TableCell>
                  </>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-4 text-xs text-ink-muted">
          Tracking since {impact.trackingSince ? monthLabel(impact.trackingSince) : "your first nightly shelf check"}.
          Down is the good direction for both — fewer empty shelves and fewer products sitting unsold.
        </p>
      </CardContent>
    </Card>
  );
}
