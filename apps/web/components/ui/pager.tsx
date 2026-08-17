import Link from "next/link";
import { cn } from "@/lib/cn";

/** Table pager. Says how much of the matched list is on screen — a shop with
 *  400+ rows must never be left guessing whether the rest is missing or merely
 *  further down — and the numbered links are the way to a far page without
 *  clicking Next eight times.
 *
 *  Lifted out of the catalogue so every long table pages the same way. `label`
 *  names the list for screen readers ("Catalogue pages", "Activity pages"); the
 *  href builder stays with the caller because each screen carries its own
 *  filters in the query string. */
export function Pager({
  page,
  pageCount,
  from,
  to,
  total,
  pageHref,
  label = "Pages",
  unit,
}: {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  pageHref: (page: number) => string;
  label?: string;
  /** What is being counted, when it isn't rows — "suppliers", "branches".
   *  A queue paged by supplier card says "1–5 of 12" and means twelve
   *  suppliers, not twelve order lines; without the word the reader counts
   *  the wrong thing. */
  unit?: string;
}) {
  const step =
    "rounded-sm border border-edge px-2 py-1 text-ink-muted transition-colors hover:text-ink hover:bg-surface-2";
  const muted = "rounded-sm border border-edge px-2 py-1 text-ink-muted opacity-40";
  // A window around the current page: a 1000-SKU catalogue is 20 pages, and
  // twenty numbers in a row is a wall rather than a control.
  const span = 2;
  const first = Math.max(0, Math.min(page - span, pageCount - (span * 2 + 1)));
  const last = Math.min(pageCount - 1, Math.max(page + span, span * 2));

  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-edge px-5 py-3 text-2xs text-ink-muted"
    >
      <span>
        Showing {from}–{to} of {total}
        {unit ? ` ${unit}` : ""}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {page === 0 ? (
          <span className={muted}>← Previous</span>
        ) : (
          <Link href={pageHref(page - 1)} scroll={false} className={step}>
            ← Previous
          </Link>
        )}
        {first > 0 && <span className="px-1">…</span>}
        {Array.from({ length: last - first + 1 }, (_, i) => first + i).map((n) => (
          <Link
            key={n}
            href={pageHref(n)}
            scroll={false}
            aria-label={`Page ${n + 1} of ${pageCount}`}
            aria-current={n === page ? "page" : undefined}
            className={cn(step, n === page && "border-accent-200 bg-accent-soft font-medium text-accent-ink")}
          >
            {n + 1}
          </Link>
        ))}
        {last < pageCount - 1 && <span className="px-1">…</span>}
        {page >= pageCount - 1 ? (
          <span className={muted}>Next →</span>
        ) : (
          <Link href={pageHref(page + 1)} scroll={false} className={step}>
            Next →
          </Link>
        )}
      </span>
    </nav>
  );
}
