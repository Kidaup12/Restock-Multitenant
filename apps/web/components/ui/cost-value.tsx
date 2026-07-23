import { cn } from "@/lib/cn";

/**
 * Money formatting + the cost-visibility seam.
 *
 * CostValue is the single place cost/margin figures render. It reads one dumb
 * `canViewCosts` boolean (default true) and masks either when that is false or
 * when the amount is null — the data layer nulls cost fields for money-blind
 * members, so a redacted payload renders as the mask with no wiring beyond the
 * value itself. Nothing here knows about roles or sessions.
 */

/** Thousands-separated integer, e.g. 1234567 -> "1,234,567". */
export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-KE");
}

/** Compact money magnitude: 1_550_000 -> "1.55M", 214_000 -> "214K", 830 -> "830". */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 100_000) return `${Math.round(value / 1_000)}K`;
  return formatNumber(value);
}

export function CostValue({
  amount,
  canViewCosts = true,
  compact = false,
  className,
}: {
  /** Null means "redacted upstream" and always renders the mask. */
  amount: number | null;
  canViewCosts?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", className)}>
      {canViewCosts && amount != null
        ? `KES ${compact ? formatCompact(amount) : formatNumber(amount)}`
        : "KES •••"}
    </span>
  );
}
