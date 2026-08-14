import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import type { ProductDetail } from "@/lib/data/product-detail";
import { TrustChips } from "@/app/(shell)/plan/buy-checklist";

/**
 * One product's whole story: what it is, what it's doing, what the run thinks,
 * and a year of months so seasonality is visible rather than inferred.
 *
 * Server component — the payload is already redacted, so nothing here decides
 * what a money-blind member may see.
 */

const URGENCY_TONE: Record<string, "negative" | "warning" | "neutral"> = {
  critical: "negative",
  high: "warning",
  medium: "neutral",
  low: "neutral",
};

const CONFIDENCE_WORD: Record<string, string> = {
  sure: "Sure",
  fairly_sure: "Fairly sure",
  guessing: "Guessing",
};

export function ProductDetailView({
  detail,
  canViewCosts,
}: {
  detail: ProductDetail;
  canViewCosts: boolean;
}) {
  const peak = Math.max(1, ...detail.months.map((m) => m.units));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={detail.title}
          subtitle={[detail.sku || "no SKU", detail.variantTitle, detail.vendor]
            .filter(Boolean)
            .join(" · ")}
          action={
            <span className="flex items-center gap-2">
              {detail.abc && <Badge tone="neutral">Class {detail.abc}</Badge>}
              <Badge tone={detail.lifecycle === "active" ? "positive" : "neutral"}>
                {detail.lifecycleLabel}
              </Badge>
            </span>
          }
        />
        <CardContent className="pt-0">
          {/* The buy list's own words for why it's holding this back — otherwise a
              retired product reads as an ordinary one that nobody is ordering. */}
          {detail.heldReason && (
            <p className="mb-4 rounded-md bg-surface-2 px-3 py-2 text-sm text-ink">
              {detail.heldReason}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label="On hand" value={`${detail.onHandUnits}`} />
            <Figure
              label="En route"
              value={detail.onOrderUnits > 0 ? `${detail.onOrderUnits}` : "—"}
              note={detail.onOrderUnits > 0 ? (detail.expectedArrivalLabel ?? "no ETA") : undefined}
            />
            <Figure label="Sells/day" value={`${detail.runRatePerDay}`} />
            <Figure
              label="Days cover"
              value={detail.daysCover != null ? `${detail.daysCover}d` : "—"}
            />
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          {/* The figures in this card are the run's, frozen; the ones at the top
              of the page are today's. Saying so here — before the reasoning, not
              in a footnote under it — is what stops the two being read as one. */}
          <CardHeader
            title="What the last run decided"
            subtitle={
              detail.prediction
                ? `As it stood on ${detail.prediction.runLabel} — the figures at the top of the page are today's`
                : undefined
            }
          />
          <CardContent className="pt-0">
            {detail.prediction ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-2xl text-ink">
                    {detail.prediction.recommendedQty}
                  </span>
                  <span className="text-sm text-ink-muted">units suggested</span>
                  <Badge tone={URGENCY_TONE[detail.prediction.urgency] ?? "neutral"}>
                    {detail.prediction.urgency}
                  </Badge>
                  {detail.prediction.confidenceWord && (
                    <Badge tone="neutral">
                      {CONFIDENCE_WORD[detail.prediction.confidenceWord] ??
                        detail.prediction.confidenceWord}
                    </Badge>
                  )}
                  {/* The plan's own cold-start chip, rendered from the plan's
                      component so the two screens can't drift apart: a product
                      the run called too new, or sized off a borrowed shape,
                      says so here too. */}
                  <TrustChips
                    row={{
                      confidence: null,
                      coldStart: detail.prediction.coldStart,
                      borrowedFromTitle: detail.prediction.borrowedFromTitle,
                    }}
                  />
                </div>
                <p className="text-sm text-ink-secondary">{detail.prediction.reasoning}</p>
                {detail.prediction.daysUntilStockout != null && (
                  <p className="text-xs text-ink-faint">
                    Heading for a stockout in about {detail.prediction.daysUntilStockout} days on
                    that day&apos;s stock.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                No forecast has covered this product yet. Run the forecast from Today.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Cost, price and supplier" />
          <CardContent className="pt-0">
            <dl className="grid grid-cols-2 gap-4">
              <Figure label="Selling price" value={`KES ${detail.priceKes.toLocaleString()}`} />
              <Figure
                label="Unit cost"
                value={<CostValue amount={detail.unitCostKes} canViewCosts={canViewCosts} />}
                note={detail.costSource ?? undefined}
              />
              <Figure
                label="Cash in this stock"
                value={<CostValue amount={detail.stockValueKes} canViewCosts={canViewCosts} />}
              />
              <Figure label="Revenue, 30 days" value={`KES ${detail.revenue30dKes.toLocaleString()}`} />
              <Figure label="Supplier" value={detail.supplierName ?? "Not assigned"} />
              <Figure
                label="Lead time"
                value={detail.effectiveLeadDays != null ? `${detail.effectiveLeadDays}d` : "—"}
                note={detail.supplierMoq != null ? `MOQ ${detail.supplierMoq}` : undefined}
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Sales by month"
          subtitle="The last 12 months — a quiet month is information, so it shows as a zero"
        />
        <CardContent className="pt-0">
          <ul className="flex items-end gap-2 overflow-x-auto">
            {detail.months.map((m) => (
              <li key={m.key} className="flex min-w-12 flex-1 flex-col items-center gap-1">
                <span className="text-xs text-ink-faint">{m.units}</span>
                <span
                  className="w-full rounded-t bg-accent-soft"
                  style={{ height: `${Math.max(2, Math.round((m.units / peak) * 96))}px` }}
                  aria-hidden
                />
                <span className="text-xs text-ink-muted">{m.label}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-1 font-medium text-ink">{value}</dd>
      {note && <dd className="text-xs text-ink-faint">{note}</dd>}
    </div>
  );
}
