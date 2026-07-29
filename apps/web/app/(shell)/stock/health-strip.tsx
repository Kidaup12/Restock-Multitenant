"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";

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

const toneStyles: Record<HealthChipTone, { on: string; off: string }> = {
  neutral: { on: "border-edge-strong bg-surface-2 text-ink", off: "border-edge bg-surface text-ink-muted hover:text-ink" },
  warning: { on: "border-warning bg-warning-soft text-warning", off: "border-edge bg-surface text-ink-muted hover:text-ink" },
  negative: { on: "border-negative bg-negative-soft text-negative", off: "border-edge bg-surface text-ink-muted hover:text-ink" },
  accent: { on: "border-edge-strong bg-accent-soft text-accent-ink", off: "border-edge bg-surface text-ink-muted hover:text-ink" },
};

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
    <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-3">
      <div role="group" aria-label="Catalogue scope" className="flex flex-wrap items-center gap-2">
        {scopes.map((s) => {
          const on = scope === s.key;
          return (
            <Link
              key={s.key}
              href={scopeHref(s.key)}
              scroll={false}
              aria-current={on ? "true" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors",
                on
                  ? "border-edge-strong bg-accent-soft text-accent-ink"
                  : "border-edge bg-surface text-ink-muted hover:text-ink",
              )}
            >
              {s.label}
              <span className={cn("rounded-full px-1.5 text-xs", on ? "bg-surface/60" : "bg-surface-2 text-ink-faint")}>
                {s.count}
              </span>
            </Link>
          );
        })}
      </div>
      <span aria-hidden className="mx-1 h-5 w-px bg-edge" />

      <Link
        href={clearHref}
        scroll={false}
        className={cn(
          "rounded-md border px-2.5 py-1 text-sm font-medium transition-colors",
          active == null ? "border-edge-strong bg-surface-2 text-ink" : "border-edge bg-surface text-ink-muted hover:text-ink",
        )}
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
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors",
              on ? style.on : style.off,
            )}
          >
            {chip.label}
            <span className={cn("rounded-full px-1.5 text-xs", on ? "bg-surface/60" : "bg-surface-2 text-ink-faint")}>
              {chip.count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
