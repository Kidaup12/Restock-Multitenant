import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { SupplierScore } from "@/lib/po/supplier-stats";

/**
 * Compact supplier scorecard: on-time %, fill-rate %, learned lead time —
 * all derived from real deliveries. Nothing renders until a delivery lands,
 * so a fresh supplier never shows an invented score.
 *
 * On-time needs a promised date, which an order only carries when the supplier
 * has a delivery time set. Without one the figure is permanently missing, so
 * the card says so and links to where the delivery time is set — this screen
 * has no way to set it.
 */
export function SupplierScoreBadges({ score }: { score: SupplierScore | null }) {
  if (!score || score.deliveredPos === 0) {
    return <span className="text-xs text-ink-faint">No deliveries scored yet</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {score.onTimeStatus === "no_promised_date" && (
        <Link
          href="/suppliers"
          className="text-xs text-ink-muted underline-offset-2 hover:underline"
          title="Nothing was promised on this supplier's orders, so no delivery can be called on time. Give them a delivery time and orders you send from now on are scored."
        >
          Set a lead time to score on-time
        </Link>
      )}
      {score.onTimeStatus === "awaiting_completion" && (
        <span className="text-xs text-ink-muted" title="On-time is scored once a delivery is fully checked in.">
          On-time pending
        </span>
      )}
      {score.onTimePct != null && (
        <Badge tone={score.onTimePct >= 80 ? "positive" : score.onTimePct >= 50 ? "warning" : "negative"}>
          On-time {score.onTimePct}%
        </Badge>
      )}
      {score.fillRatePct != null && (
        <Badge tone={score.fillRatePct >= 95 ? "positive" : score.fillRatePct >= 80 ? "warning" : "negative"}>
          Fill {score.fillRatePct}%
        </Badge>
      )}
      {score.learnedLeadDays != null && (
        <Badge tone="neutral">Lead ~{score.learnedLeadDays}d</Badge>
      )}
    </span>
  );
}
