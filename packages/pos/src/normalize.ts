/**
 * Till-SKU normalization. POS codes arrive with inconsistent case and padding
 * ("CAN-SHE-340 ", "can-she-340"); every match, ignore-rule check, and unmatched
 * roll-up keys off the SAME normalized form so the same physical SKU is one row.
 *
 * Deliberately conservative: trim + lowercase only. We do NOT strip separators
 * or collapse whitespace — a POS code and a catalogue SKU that differ by a dash
 * are genuinely different codes, and silently equating them would mis-attribute
 * revenue (the cardinal POS sin). Recovery of near-miss codes is a human
 * decision in the fix queue, not a guess here.
 */
export function normalizeSku(sku: string | null | undefined): string {
  return (sku ?? "").trim().toLowerCase();
}
