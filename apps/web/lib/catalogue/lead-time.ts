/**
 * Whether a typed lead time can be accepted, and what to say when it cannot.
 *
 * Pure and outside the component so the messages can be tested against the
 * real rule. Inlined, the only way to test it was to restate it in the test —
 * which passes happily while the component's bounds change underneath.
 *
 * The editor used to refuse bad input by silently restoring the old number, so
 * a rejected value looked exactly like a value that had never been typed.
 */
export function validateLeadDays(typed: string): string | null {
  // Blank is a real choice: it hands the row back to its supplier's lead time,
  // which is the only way to undo a per-product override.
  if (typed === "") return null;
  const days = Number(typed);
  if (!Number.isFinite(days)) return "Enter a number of days.";
  if (days < 0) return "Days cannot be negative.";
  if (days > MAX_LEAD_DAYS) return `That is over a year — enter ${MAX_LEAD_DAYS} or fewer days.`;
  return null;
}

/** A year. Beyond it the number is far more likely to be a typo than a
 *  supplier who takes fourteen months. */
export const MAX_LEAD_DAYS = 365;
