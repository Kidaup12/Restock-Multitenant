"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { SegmentedNav } from "@/components/ui/segmented-nav";

/**
 * Catalogue health strip (spec §2): a row of clickable chips above the table —
 * every issue count filters the list to it, and clears by toggling off. Purely
 * presentational; the catalogue view owns the counts (derived from the loaded
 * rows) and the active filter.
 *
 * The strip opens with the scope chips (Selling / Archived & removed / All).
 * They pick WHICH catalogue the rest of the strip is counting, so they read as
 * one exclusive group and always carry their count — a shop with archived SKUs
 * can see they exist without leaving the day-to-day view.
 */

export type HealthChipTone = "neutral" | "warning" | "negative" | "accent";

export type HealthChip = {
  key: string;
  label: string;
  count: number;
  tone: HealthChipTone;
};

const OFF = "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink";

/** A selected filter is a tinted fill with a hairline of its own colour — the
 *  same treatment the status chips use, so a filter and the thing it filters for
 *  read as the same idea. */
const toneStyles: Record<HealthChipTone, { on: string; off: string }> = {
  neutral: { on: "border-edge-strong bg-surface-2 text-ink", off: OFF },
  warning: { on: "border-warning/30 bg-warning/10 text-warning", off: OFF },
  negative: { on: "border-negative/30 bg-negative/10 text-negative", off: OFF },
  accent: { on: "border-accent-200 bg-accent-soft text-accent-ink", off: OFF },
};

/** Shared shape for every chip in the strip. */
const CHIP =
  "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors";

/** The count that rides inside a chip. */
function ChipCount({ value, on }: { value: number; on: boolean }) {
  return (
    <span
      className={cn(
        "rounded-xs px-1.5 font-mono tabular-nums",
        on ? "bg-surface/50" : "bg-surface-2 text-ink-faint",
      )}
    >
      {value}
    </span>
  );
}

export function HealthStrip({
  total,
  shown,
  chips,
  active,
  chipHref,
  clearHref,
  scopes,
  scope,
  scopeHref,
}: {
  total: number;
  shown: number;
  chips: HealthChip[];
  active: string | null;
  /** Where a chip points — toggling off is the caller's job, since it owns the
   *  rest of the query. Links rather than handlers because each one is a real
   *  navigation: the server reads the filters and decides which rows to send. */
  chipHref: (key: string) => string;
  clearHref: string;
  scopes: HealthChip[];
  scope: string;
  scopeHref: (key: string) => string;
}) {
  const live = chips.filter((c) => c.count > 0);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge px-5 py-3">
      <SegmentedNav
        label="Catalogue scope"
        items={scopes.map((s) => ({
          href: scopeHref(s.key),
          label: s.label,
          count: s.count,
          active: scope === s.key,
        }))}
      />
      <span aria-hidden className="mx-1 h-5 w-px bg-edge" />

      <Link
        href={clearHref}
        scroll={false}
        className={cn(CHIP, active == null ? toneStyles.neutral.on : OFF)}
      >
        {shown === total ? `${total} products` : `${shown} of ${total}`}
      </Link>

      {live.map((chip) => {
        const on = active === chip.key;
        const style = toneStyles[chip.tone];
        return (
          <Link
            key={chip.key}
            href={chipHref(chip.key)}
            scroll={false}
            aria-current={on ? "true" : undefined}
            className={cn(CHIP, on ? style.on : style.off)}
          >
            {chip.label}
            <ChipCount value={chip.count} on={on} />
          </Link>
        );
      })}
    </div>
  );
}
