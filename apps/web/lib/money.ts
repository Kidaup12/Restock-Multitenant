/**
 * Money formatting. Plain module, deliberately NOT a client component.
 *
 * `CostValue` has to be a client component so it can read the workspace's
 * currency from context — but marking the file `"use client"` turns every
 * export in it into a client reference, and a server component that calls one
 * throws at render. Typecheck, lint and the unit suite all stay green; only the
 * build output or the running page shows it. So the pure functions live here,
 * where both sides can import them, and the component imports them too.
 *
 * Deliberately NOT `Intl.NumberFormat` with `style: "currency"`: it inserts a
 * non-breaking space between the code and the number, which is invisible in a
 * diff and breaks every string comparison in the suite.
 */

export const DEFAULT_CURRENCY = "KES";

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

/** "KES 1,234". For anywhere without React context: emails, CSV cells, toasts. */
export function formatMoney(
  value: number,
  currency: string = DEFAULT_CURRENCY,
  options: { compact?: boolean } = {}
): string {
  return `${currency} ${options.compact ? formatCompact(value) : formatNumber(value)}`;
}

/** The mask a member sees in place of a cost. */
export function maskedMoney(currency: string = DEFAULT_CURRENCY): string {
  return `${currency} •••`;
}
