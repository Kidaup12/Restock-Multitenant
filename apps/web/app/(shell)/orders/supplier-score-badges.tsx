import { Badge } from "@/components/ui/badge";
import type { SupplierScore } from "@/lib/po/supplier-stats";

/**
 * Compact supplier scorecard: on-time %, fill-rate %, learned lead time —
 * all derived from real deliveries. Nothing renders until a delivery lands,
 * so a fresh supplier never shows an invented score.
 */
export function SupplierScoreBadges({ score }: { score: SupplierScore | null }) {
  if (!score || score.deliveredPos === 0) {
    return <span className="text-xs text-ink-faint">No deliveries scored yet</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
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
