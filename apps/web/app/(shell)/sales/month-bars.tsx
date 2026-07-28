import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCompact, formatMoney } from "@/lib/money";
import { getRevenueByMonth } from "@/lib/data/sales";

/** Revenue by calendar month as simple bars. The current month is partial —
 *  labelled so the shorter bar doesn't read as a slump. The subtitle and the
 *  bar labels are plain strings, so the currency arrives as a prop. */
export async function MonthBars({
  tenantId,
  currency,
}: {
  tenantId: string;
  currency: string;
}) {
  const months = await getRevenueByMonth(tenantId, 4);
  const max = Math.max(...months.map((m) => m.revenueKes));

  if (max <= 0) {
    return (
      <Card>
        <CardHeader title="Revenue by month" />
        <CardContent>
          <EmptyState
            title="No sales history yet"
            description="Monthly revenue appears once sales are recorded."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Revenue by month" subtitle={`All channels, ${currency}`} />
      <CardContent>
        <div className="flex h-48 items-end gap-4">
          {months.map((m, index) => {
            const heightPct = Math.max(2, Math.round((m.revenueKes / max) * 100));
            // getRevenueByMonth always ends at the current (partial) month.
            const partial = index === months.length - 1;
            return (
              <div key={m.month} className="flex h-full flex-1 flex-col justify-end gap-2">
                <div className="text-center font-mono text-xs text-ink tabular-nums">
                  {formatCompact(m.revenueKes)}
                </div>
                <div
                  className="w-full rounded-t-md bg-accent"
                  style={{ height: `${heightPct}%`, opacity: partial ? 0.55 : 1 }}
                  role="img"
                  aria-label={`${m.label}: ${formatMoney(m.revenueKes, currency, { compact: true })}${partial ? " so far" : ""}`}
                />
                <div className="text-center text-xs text-ink-muted">
                  {m.label}
                  {partial && <span className="text-ink-muted/70"> (to date)</span>}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
