import Link from "next/link";
import { cn } from "@/lib/cn";

/* On small screens the table scrolls inside its container instead of squashing columns. */
export function Table({
  className,
  dense = false,
  children,
}: {
  className?: string;
  /** Narrows the column gutters for a table with enough columns to overflow its
   *  card on a laptop. Nine columns spend 360px on gutters alone, which is what
   *  pushed the row actions off the side of the suppliers table — the room comes
   *  back from the spacing rather than from dropping a column someone needs. */
  dense?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn(
          "w-full min-w-[560px] text-sm",
          dense && "[&_td]:px-3 [&_th]:px-3",
          className,
        )}
      >
        {children}
      </table>
    </div>
  );
}

export function TableHeader({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-edge bg-surface-2">{children}</tr>
    </thead>
  );
}

export function TableBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TableRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <tr
      className={cn(
        "border-b border-edge transition-colors last:border-0 hover:bg-surface-2/60",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TableHead({
  numeric = false,
  sort,
  className,
  children,
}: {
  numeric?: boolean;
  /** How this column is currently sorted, for a reader who cannot see the
   *  arrow. Omitted on a column that does not sort at all — "none" means
   *  "sortable, not sorted by", which is a different claim. */
  sort?: "ascending" | "descending" | "none";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      aria-sort={sort}
      className={cn(
        // `relative` so a visually-hidden label stays inside its own column.
        // `sr-only` positions absolutely, and with no positioned ancestor it
        // resolves against the page — a screen-reader-only "Actions" heading in
        // a wide table pushed the whole admin page 88px sideways.
        "relative px-5 py-3 text-left text-2xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase",
        numeric && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TableCell({
  numeric = false,
  className,
  children,
}: {
  numeric?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <td
      className={cn(
        "px-5 py-3 whitespace-nowrap text-ink-secondary",
        numeric && "text-right font-mono tabular-nums text-ink",
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * A column heading that sorts.
 *
 * Shared because both tables had their own copy, character-identical down to
 * the comment — and the copies had already begun to drift. The label bug this
 * replaces existed twice: it was computed from whether the column was ALREADY
 * ascending while the link's direction came from a separate expression, so
 * every column that opens high-to-low announced the opposite of what it did.
 * Here the label and the href read the same value, which is the only way the
 * two cannot disagree again.
 *
 * Clicking the column you are on flips the direction; clicking a new one opens
 * on the order people actually ask that column for. Nobody opens a stock screen
 * wanting the LEAST stock, so quantities start high-to-low and cover, margin
 * and lead start low-to-high, where the trouble is.
 */
export function SortableHead<K extends string>({
  label,
  sortKey,
  activeKey,
  desc,
  hrefFor,
  numeric,
  startAsc,
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  desc: boolean;
  hrefFor: (sortKey: K, desc: boolean) => string;
  numeric?: boolean;
  /** Open this column low-to-high — for a column whose interesting end is the
   *  small one (cover, margin, lead time). */
  startAsc?: boolean;
}) {
  const active = activeKey === sortKey;
  const nextDesc = active ? !desc : !startAsc;
  return (
    <TableHead numeric={numeric} sort={active ? (desc ? "descending" : "ascending") : "none"}>
      <Link
        href={hrefFor(sortKey, nextDesc)}
        scroll={false}
        aria-label={`Sort by ${label}, ${nextDesc ? "descending" : "ascending"}`}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm hover:text-ink",
          active ? "text-ink" : "text-ink-muted",
        )}
      >
        {label}
        {/* Only the active column shows an arrow. A caret on every heading says
            "sortable" and stops saying "sorted by this". */}
        {active && <span aria-hidden>{desc ? "↓" : "↑"}</span>}
      </Link>
    </TableHead>
  );
}
