"use client";

import { cn } from "@/lib/cn";
import { useCurrency } from "@/components/currency-provider";
import { formatMoney, maskedMoney } from "@/lib/money";

/**
 * The cost-visibility seam.
 *
 * CostValue is the single place cost/margin figures render. It reads one dumb
 * `canViewCosts` boolean (default true) and masks either when that is false or
 * when the amount is null — the data layer nulls cost fields for money-blind
 * members, so a redacted payload renders as the mask with no wiring beyond the
 * value itself. Nothing here knows about roles or sessions.
 *
 * The currency comes from the workspace via context, not a prop, so a screen
 * cannot forget to pass it. The formatting itself lives in `lib/money.ts`
 * because this file is a client module: server components must import the
 * formatters from there, not from here.
 */

// The formatters are deliberately NOT re-exported here. A re-export from a
// client module is still a client reference, so it would break a server
// component just as surely as defining it here would — while looking like it
// works. Import them from "@/lib/money".

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
  const currency = useCurrency();
  const masked = !canViewCosts || amount == null;
  return (
    <span
      className={cn("tabular-nums", masked && "text-ink-faint select-none", className)}
      // A masked figure is withheld, not missing. The reference renders a bare
      // dash for the same case, which tells a money-blind member the shop has no
      // cost on file — a different and wrong statement. The glyphs stay, dimmed.
      title={masked ? "You don't have access to cost figures" : undefined}
    >
      {masked ? maskedMoney(currency) : formatMoney(amount, currency, { compact })}
    </span>
  );
}
