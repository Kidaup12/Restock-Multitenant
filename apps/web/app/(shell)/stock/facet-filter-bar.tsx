"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import {
  FACET_KEYS,
  FACET_LABELS,
  type FacetKey,
  type FacetOptions,
  type FacetSelection,
} from "@/lib/facets";

/**
 * Filter bar over the metadata facets — the reusable demonstrator the Stock
 * catalogue adopts this wave. Options come pre-derived from the real catalogue
 * (never hard-coded); this component only renders and toggles them. AND across
 * facets, OR within a facet — matching lib/facets' matchesFacets predicate.
 *
 * Generic on the facet contract, not on Stock: filtering/sorting (Phase B) and
 * planner scoping (Phase D) reuse it. Kept in the stock folder until a later
 * wave promotes it to shared components.
 */
export function FacetFilterBar({
  options,
  selection,
  selectionHref,
}: {
  options: FacetOptions;
  selection: FacetSelection;
  /** Where a given selection lives. The bar still owns the toggle arithmetic —
   *  it just resolves to a URL instead of a callback, because filtering is a
   *  navigation: the server reads the selection and returns the matching page. */
  selectionHref: (next: FacetSelection) => string;
}) {
  const activeFacets = FACET_KEYS.filter((key) => options[key].length > 0);
  const activeCount = Object.values(selection).reduce((n, vals) => n + (vals?.length ?? 0), 0);

  function toggled(key: FacetKey, value: string): FacetSelection {
    const current = selection[key] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    const out: FacetSelection = { ...selection };
    if (next.length > 0) out[key] = next;
    else delete out[key];
    return out;
  }

  if (activeFacets.length === 0) return null;

  return (
    <div className="flex flex-wrap items-start gap-2 border-b border-edge px-4 pb-3">
      {activeFacets.map((key) => {
        const chosen = selection[key] ?? [];
        return (
          <details key={key} className="group relative">
            <summary
              className={cn(
                "flex cursor-pointer list-none items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors",
                chosen.length > 0
                  ? "border-edge-strong bg-accent-soft text-accent-ink"
                  : "border-edge bg-surface text-ink-muted hover:text-ink"
              )}
            >
              {FACET_LABELS[key]}
              {chosen.length > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-xs text-white">
                  {chosen.length}
                </span>
              )}
            </summary>
            <div className="absolute z-10 mt-1 flex max-h-72 min-w-44 max-w-64 flex-wrap gap-1 overflow-auto rounded-lg border border-edge bg-surface p-2 shadow-lg">
              {options[key].map((opt) => {
                const on = chosen.includes(opt.value);
                return (
                  <Link
                    key={opt.value}
                    href={selectionHref(toggled(key, opt.value))}
                    scroll={false}
                    aria-current={on ? "true" : undefined}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs transition-colors",
                      on
                        ? "border-edge-strong bg-accent-soft text-accent-ink"
                        : "border-edge bg-surface-2 text-ink-muted hover:text-ink"
                    )}
                  >
                    {opt.label}
                    <span className="ml-1 text-ink-faint">{opt.count}</span>
                  </Link>
                );
              })}
            </div>
          </details>
        );
      })}
      {activeCount > 0 && (
        <Link
          href={selectionHref({})}
          scroll={false}
          className="rounded-md px-2 py-1 text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Clear ({activeCount})
        </Link>
      )}
    </div>
  );
}
