/**
 * How long the shelf lasts, in one place.
 *
 * Three tables rendered this themselves and all three agreed on the wrong
 * answer: an empty shelf showed a dash. Zero stock is not "unknown" — it is the
 * most urgent state the column has, and printing nothing for it hides exactly
 * the rows a buyer is looking for. The shop noticed before we did.
 *
 * The CSV export never had the bug, which is the tell: it wrote the number
 * straight out, so the file and the screen disagreed about the same row.
 *
 * Two states, opposite meanings, deliberately not collapsed:
 *
 *   nothing on the shelf → `0d`. It is out now.
 *   no days figure at all → the product sells too slowly to run out inside the
 *     forecast horizon. Showing `0` there would say the opposite of the truth,
 *     so it stays a dash — but one that says why on hover, rather than a bare
 *     mark the reader has to guess at.
 */
export function DaysLeft({
  days,
  onHandUnits,
}: {
  /** Null when the run rate is ~zero and no stockout is predicted. */
  days: number | null;
  onHandUnits: number;
}) {
  if (onHandUnits <= 0) return <span className="font-medium text-negative">0d</span>;
  if (days == null) {
    return (
      <span className="text-ink-faint" title="Selling too slowly to run out — no stockout predicted">
        —
      </span>
    );
  }
  return <>{days}d</>;
}
