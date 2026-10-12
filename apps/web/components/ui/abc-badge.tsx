import { Badge } from "@/components/ui/badge";

/**
 * The one place a product's ABC class becomes a chip.
 *
 * Every list rendered the class inline as `<Badge>{abc}</Badge>` — most grey,
 * one (missed-revenue) coloured A=critical/B=warning/C=neutral. Grey everywhere
 * throws away the signal the class carries; colour on one screen and not the
 * next reads as two different meanings. This centralises the mapping so an
 * A-class chip looks the same, and means the same, on every table.
 *
 * The tone is the same judgement the shop makes: A is what the business leans
 * on, so an A in trouble (empty shelf, dead stock) is the loudest; B is the
 * mid-tier warning; C is the quiet long tail. Null/unrated is a plain dash — a
 * product too new to rank should not borrow C's styling.
 */

/** A is what the shop leans on; an A in trouble reads worst. */
export function abcTone(value: string | null | undefined): "critical" | "warning" | "neutral" {
  return value === "A" ? "critical" : value === "B" ? "warning" : "neutral";
}

export function AbcBadge({
  value,
  unratedLabel,
}: {
  value: string | null | undefined;
  /** What to show for an unrated value. Defaults to a dash — right for a
   *  per-product cell (the product simply isn't classified). In an AGGREGATE
   *  context, where the row/chip IS the "unrated" bucket, pass "Unrated" so the
   *  label doesn't vanish into a dash. */
  unratedLabel?: string;
}) {
  if (value !== "A" && value !== "B" && value !== "C") {
    if (unratedLabel) {
      return <span className="text-2xs font-medium text-ink-muted">{unratedLabel}</span>;
    }
    // Unrated / too-new: a dash, not a C-styled chip it hasn't earned.
    return <span className="text-2xs text-ink-faint">—</span>;
  }
  return (
    <Badge tone={abcTone(value)} title={`Class ${value}`}>
      {value}
    </Badge>
  );
}
