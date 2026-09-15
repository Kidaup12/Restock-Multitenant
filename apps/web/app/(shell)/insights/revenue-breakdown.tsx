import { getRevenueBreakdown, type RevenueGroup } from "@/lib/data/insights";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatNumber } from "@/lib/money";
import { cols } from "@/lib/export/print-pdf";
import { ExportPdfButton } from "./export-pdf-button";

/**
 * Where the money actually comes from — revenue rolled up by category and by
 * brand over the report window.
 *
 * Revenue is a sales figure (price already earned), so there is NO cost gate
 * here: every role sees the same numbers. The component is named
 * `RevenueBreakdownSection` on purpose — the loader already exports a
 * `RevenueBreakdown` type, and a same-named component would clash on import.
 *
 * Each list is a compact ranking with a proportional bar drawn against the
 * biggest earner in that list, so the shape of the money reads at a glance
 * rather than from the digits alone.
 */

/** One ranked list — category or brand — as a bar chart of revenue shares. */
function RevenueList({
  heading,
  groups,
  currency,
}: {
  heading: string;
  groups: RevenueGroup[];
  currency: string;
}) {
  // Bars are drawn against the top earner in THIS list, so each list fills its
  // own width rather than being dwarfed by the other one's leader.
  const max = groups.reduce((m, g) => Math.max(m, g.revenueKes), 0);
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-muted">{heading}</h3>
      {groups.length === 0 ? (
        <p className="text-sm text-ink-muted">No sales in this window.</p>
      ) : (
        <ul className="space-y-2.5">
          {groups.map((g) => (
            <li key={g.name} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-medium text-ink">{g.name}</span>
                <span className="shrink-0 font-mono text-sm tabular-nums text-ink">
                  {formatMoney(g.revenueKes, currency, { compact: true })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${max > 0 ? Math.max(2, (g.revenueKes / max) * 100) : 0}%` }}
                  />
                </div>
                <span className="shrink-0 text-2xs text-ink-muted">
                  {formatNumber(g.skuCount)} {g.skuCount === 1 ? "SKU" : "SKUs"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export async function RevenueBreakdownSection({
  tenantId,
  currency,
  days,
}: {
  tenantId: string;
  currency: string;
  /** The period the report is set to — the revenue window. */
  days: number;
}) {
  const { byCategory, byBrand, windowDays } = await getRevenueBreakdown(tenantId, { days });

  const hasData = byCategory.length > 0 || byBrand.length > 0;

  // One PDF matrix over both lists, tagged with which grouping each row came
  // from. Revenue is a sales figure, so nothing is redacted.
  const pdf = {
    columns: cols(["Grouping", "Name", "Revenue", "SKUs"], [2, 3]),
    rows: [
      ...byCategory.map((g) => ["Category", g.name, formatMoney(g.revenueKes, currency), formatNumber(g.skuCount)]),
      ...byBrand.map((g) => ["Brand", g.name, formatMoney(g.revenueKes, currency), formatNumber(g.skuCount)]),
    ],
  };

  return (
    <Card data-tour="insights-revenue-breakdown">
      <CardHeader
        title={`Where the money comes from · ${windowDays} days`}
        subtitle="Revenue by category and by brand, ranked"
        action={
          hasData ? (
            <ExportPdfButton
              title={`Where the money comes from · ${windowDays} days`}
              subtitle="Revenue by category and by brand"
              columns={pdf.columns}
              rows={pdf.rows}
            />
          ) : undefined
        }
      />
      <CardContent>
        {!hasData ? (
          <EmptyState
            title="No sales in this window"
            description="Once products sell in the selected period, your revenue splits appear here."
          />
        ) : (
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <RevenueList heading="Revenue by category" groups={byCategory} currency={currency} />
            <RevenueList heading="Revenue by brand" groups={byBrand} currency={currency} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
