import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * A row of mutually exclusive views, each a link.
 *
 * Four screens had built this independently from the same class string, which is
 * how the stock tabs and the transfers pills drifted a padding step apart. One
 * component now, so a change to the shape reaches all of them.
 *
 * The selected segment is ink-filled rather than accent-tinted. The accent is
 * spent on the one action a screen is about; a view switcher is navigation, and
 * on a screen that already has an accent button two competing highlights leave
 * the reader deciding which one means "you are here".
 *
 * `count` is for segments that carry a number — "Stockout 12". It reads inside
 * the segment rather than beside it so the pair moves together.
 */
export type Segment = {
  href: string;
  label: string;
  /** Rows behind this view. Omit when a count would be noise rather than news. */
  count?: number;
  active: boolean;
};

export function SegmentedNav({
  items,
  label,
  className,
  ...rest
}: {
  items: Segment[];
  /** Names the group for screen readers — "Stock views", "Cover target". */
  label: string;
  className?: string;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-md border border-edge bg-surface p-1",
        className,
      )}
      {...rest}
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "inline-flex items-center gap-2 rounded-sm px-3.5 py-1.5 text-sm transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-accent-300",
            item.active
              ? "bg-ink font-medium text-surface"
              : "text-ink-muted hover:bg-surface-2 hover:text-ink",
          )}
        >
          <span>{item.label}</span>
          {item.count != null && (
            <span
              className={cn(
                "rounded-xs px-1.5 py-0.5 font-mono text-2xs tabular-nums",
                item.active ? "bg-surface/20 text-surface" : "bg-surface-2 text-ink-muted",
              )}
            >
              {item.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
