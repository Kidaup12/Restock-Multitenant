import { deltaPercent } from "@/lib/data/delta-percent";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/money";
import { getRevenueByMonth, getSalesComparison } from "@/lib/data/sales";

/**
 * Twelve months of revenue, with the last thirty days as the headline.
 *
 * It was a 30-day daily sparkline, which shows momentum and nothing about the
 * year. A shop deciding what to reorder needs to know that December triples and
 * February halves — seasonality is the argument for buying ahead at all, and a
 * month-by-month bar is where a person sees it. The 30-day total and its
 * comparison stay in the header: recent momentum still matters, it is just not
 * what a chart on this screen should spend its space on.
 */

/** `currency` comes from the page's membership: the subtitle is a plain string,
 *  so it can't read the workspace currency from context the way CostValue does. */
export async function RevenueTrend({
  tenantId,
  currency,
}: {
  tenantId: string;
  currency: string;
}) {
  const [comparison, months] = await Promise.all([
    getSalesComparison(tenantId, 30),
    getRevenueByMonth(tenantId, 12),
  ]);

  const hasHistory = months.some((m) => m.revenueKes > 0);
  if (!hasHistory) {
    return (
      <Card>
        <CardHeader title="Revenue trend" subtitle="No sales recorded yet" />
        <CardContent>
          <EmptyState
            title="No sales history yet"
            description="Once sales sync in, the last twelve months appear here."
          />
        </CardContent>
      </Card>
    );
  }

  const total = comparison.revenueKes;
  const perDay = total / comparison.windowDays;
  const deltaPct = deltaPercent(total, comparison.priorRevenueKes);
  // Against the tallest month, so the shape is readable whatever the scale. A
  // floor of 2% keeps a quiet month visible as a stub rather than as nothing —
  // a bar chart where some bars render at zero pixels reads as broken.
  const peak = Math.max(...months.map((m) => m.revenueKes), 1);

  return (
    <Card>
      <CardHeader
        title="Revenue trend"
        subtitle={`Last 30 days: ${formatMoney(total, currency, { compact: true })} · ${formatMoney(perDay, currency, { compact: true })}/day average`}
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
        <div
          role="img"
          aria-label={`Revenue by month for the last ${months.length} months. ${months
            .map((m) => `${m.label}: ${formatMoney(m.revenueKes, currency, { compact: true })}`)
            .join(", ")}.`}
          className="flex h-28 items-end gap-1.5 border-b border-edge"
        >
          {months.map((m) => (
            <div
              key={m.label}
              title={`${m.label} · ${formatMoney(m.revenueKes, currency, { compact: true })}`}
              className="flex-1 rounded-t-xs bg-accent/70"
              style={{ height: `${Math.max(2, (m.revenueKes / peak) * 100)}%` }}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-2xs text-ink-muted">
          {months.map((m) => (
            <span key={m.label} className="flex-1 text-center">
              {m.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
