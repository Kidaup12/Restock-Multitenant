"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import type { BuyListRow } from "@/lib/data/plan";
// The "no value" sentinel is shared with the catalogue facets so scoping to a
// gap (uncategorised, no supplier, unranked) reads the same everywhere.
import { NONE_VALUE } from "@/lib/facets/types";
import type { SavedScope } from "./scope-actions";

/**
 * Scope bar for the buy list: narrow the checklist by ABC class, category,
 * supplier, and lead-band (how fast a restock lands). Every dimension is
 * metadata already on the row — no cost figure enters here, so a money-blind
 * member scopes exactly the list an owner does.
 *
 * Filtering is AND across dimensions, OR within one (matching the catalogue's
 * facet bar): a row shows when it satisfies every dimension that has a
 * selection, and within a dimension any one selected value is enough. Options
 * are derived from the rows on screen, never hard-coded, so a dimension with
 * fewer than two values drops out of the bar — nothing to filter by.
 */

/**
 * Lead-band buckets, keyed off the row's resolved lead days:
 * fast ≤7d · medium 8–28d · slow >28d. These are the plan's own restock-speed
 * bands, distinct from the catalogue's speed facet (which splits at 20d).
 */
export type LeadBand = "fast" | "medium" | "slow";

export const LEAD_BANDS: readonly LeadBand[] = ["fast", "medium", "slow"];

export const LEAD_BAND_LABELS: Record<LeadBand, string> = {
  fast: "Fast (≤7d)",
  medium: "Medium (8–28d)",
  slow: "Slow (>28d)",
};

export function leadBandFor(leadDays: number): LeadBand {
  if (leadDays <= 7) return "fast";
  if (leadDays <= 28) return "medium";
  return "slow";
}

/** Active scope: for each dimension, the chosen values (OR within). An empty
 *  array imposes no constraint on that dimension. */
export type ScopeSelection = {
  abc: string[];
  category: string[];
  supplier: string[];
  leadBand: LeadBand[];
};

export const EMPTY_SCOPE: ScopeSelection = {
  abc: [],
  category: [],
  supplier: [],
  leadBand: [],
};

export function isScopeActive(sel: ScopeSelection): boolean {
  return sel.abc.length + sel.category.length + sel.supplier.length + sel.leadBand.length > 0;
}

/**
 * Does a row satisfy the selection? AND across the four dimensions, OR within
 * each. A dimension with no selection imposes nothing. Null abc/category/
 * supplier match the "none" sentinel, so an owner can scope TO the gaps.
 */
export function matchesScope(row: BuyListRow, sel: ScopeSelection): boolean {
  if (sel.abc.length > 0 && !sel.abc.includes(row.abc ?? NONE_VALUE)) return false;
  if (sel.category.length > 0 && !sel.category.includes(row.category ?? NONE_VALUE)) return false;
  if (sel.supplier.length > 0 && !sel.supplier.includes(row.supplierName ?? NONE_VALUE)) return false;
  if (sel.leadBand.length > 0 && !sel.leadBand.includes(leadBandFor(row.leadDays))) return false;
  return true;
}

/** Pure row filter — the checklist renders the result. Extracted so the AND/OR
 *  logic is unit-tested without React. No selection short-circuits to the input
 *  list (same reference), so an unfiltered plan is untouched. */
export function filterBuyListRows(rows: BuyListRow[], sel: ScopeSelection): BuyListRow[] {
  if (!isScopeActive(sel)) return rows;
  return rows.filter((row) => matchesScope(row, sel));
}

type ScopeDimension = keyof ScopeSelection;
type Option = { value: string; label: string; count: number };
type ScopeFacets = Record<ScopeDimension, Option[]>;

const ABC_ORDER = ["A", "B", "C"];

/** Count rows into option buckets on one accessor, then order them: the "none"
 *  sentinel last, an optional fixed order next, then alpha by label. */
function bucket(
  rows: BuyListRow[],
  valueOf: (r: BuyListRow) => string | null,
  labelOf: (value: string) => string,
  orderOf: (value: string) => number = () => -1
): Option[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const value = valueOf(r) ?? NONE_VALUE;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: labelOf(value), count }))
    .sort((a, b) => {
      if (a.value === NONE_VALUE) return 1;
      if (b.value === NONE_VALUE) return -1;
      const ai = orderOf(a.value);
      const bi = orderOf(b.value);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.label.localeCompare(b.label);
    });
}

/** Derive each dimension's options (with live counts) from the rows on screen.
 *  Pure. Lead band is always defined (lead days default to 0), so it carries no
 *  "none" bucket. */
export function deriveScopeFacets(rows: BuyListRow[]): ScopeFacets {
  return {
    abc: bucket(
      rows,
      (r) => r.abc,
      (v) => (v === NONE_VALUE ? "Unranked" : v),
      (v) => ABC_ORDER.indexOf(v)
    ),
    category: bucket(
      rows,
      (r) => r.category,
      (v) => (v === NONE_VALUE ? "Uncategorised" : v)
    ),
    supplier: bucket(
      rows,
      (r) => r.supplierName,
      (v) => (v === NONE_VALUE ? "No supplier" : v)
    ),
    leadBand: bucket(
      rows,
      (r) => leadBandFor(r.leadDays),
      (v) => LEAD_BAND_LABELS[v as LeadBand] ?? v,
      (v) => LEAD_BANDS.indexOf(v as LeadBand)
    ),
  };
}

const DIMENSIONS: { key: ScopeDimension; label: string }[] = [
  { key: "abc", label: "ABC class" },
  { key: "category", label: "Category" },
  { key: "supplier", label: "Supplier" },
  { key: "leadBand", label: "Lead time" },
];

export function ScopeBar({
  rows,
  selection,
  onChange,
  showing,
  savedScopes = [],
  onSaveScope,
  onDeleteScope,
  scopesBusy = false,
}: {
  /** The full (unfiltered) buy-list rows — options and their counts derive from
   *  these, so a value never vanishes from the bar as you narrow the list. */
  rows: BuyListRow[];
  selection: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  /** How many rows survive the current selection — for the honest count. */
  showing: number;
  /** The caller's saved scopes, ready to apply or delete. Omitted (empty) when
   *  saving isn't wired, so the bar degrades to plain filters. */
  savedScopes?: SavedScope[];
  /** Persist the current selection under a name. Absent = the save affordance
   *  hides. */
  onSaveScope?: (name: string) => void;
  /** Remove a saved scope by id. */
  onDeleteScope?: (id: string) => void;
  /** A save/delete round-trip is in flight — disables the save control. */
  scopesBusy?: boolean;
}) {
  const facets = useMemo(() => deriveScopeFacets(rows), [rows]);
  const [name, setName] = useState("");
  // Only dimensions with something to choose between earn a control.
  const activeDims = DIMENSIONS.filter(({ key }) => facets[key].length > 1);
  const activeCount =
    selection.abc.length + selection.category.length + selection.supplier.length + selection.leadBand.length;

  function toggle(key: ScopeDimension, value: string) {
    const current = selection[key] as string[];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...selection, [key]: next });
  }

  function saveCurrent() {
    const trimmed = name.trim();
    if (!trimmed || !onSaveScope) return;
    onSaveScope(trimmed);
    setName("");
  }

  if (activeDims.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {activeDims.map(({ key, label }) => {
        const chosen = selection[key] as string[];
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
              {label}
              {chosen.length > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-xs text-white">
                  {chosen.length}
                </span>
              )}
            </summary>
            <div className="absolute z-10 mt-1 flex max-h-72 min-w-44 max-w-64 flex-wrap gap-1 overflow-auto rounded-lg border border-edge bg-surface p-2 shadow-lg">
              {facets[key].map((opt) => {
                const on = chosen.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(key, opt.value)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs transition-colors",
                      on
                        ? "border-edge-strong bg-accent-soft text-accent-ink"
                        : "border-edge bg-surface-2 text-ink-muted hover:text-ink"
                    )}
                  >
                    {opt.label}
                    <span className="ml-1 text-ink-faint">{opt.count}</span>
                  </button>
                );
              })}
            </div>
          </details>
        );
      })}
      {activeCount > 0 && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_SCOPE)}
          className="rounded-md px-2 py-1 text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Clear ({activeCount})
        </button>
      )}

      {savedScopes.length > 0 && (
        <details className="group relative">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 py-1 text-sm font-medium text-ink-muted transition-colors hover:text-ink">
            Saved scopes
            <span className="rounded-full bg-surface-2 px-1.5 text-xs text-ink-muted">
              {savedScopes.length}
            </span>
          </summary>
          <div className="absolute z-10 mt-1 flex max-h-72 min-w-52 flex-col gap-0.5 overflow-auto rounded-lg border border-edge bg-surface p-1.5 shadow-lg">
            {savedScopes.map((scope) => (
              <div key={scope.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onChange(scope.selection)}
                  className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {scope.name}
                </button>
                {onDeleteScope && (
                  <button
                    type="button"
                    onClick={() => onDeleteScope(scope.id)}
                    aria-label={`Delete scope ${scope.name}`}
                    className="rounded-md px-1.5 py-1 text-sm text-ink-faint transition-colors hover:text-negative"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {onSaveScope && activeCount > 0 && (
        <details className="group relative">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 py-1 text-sm font-medium text-ink-muted transition-colors hover:text-ink">
            Save scope
          </summary>
          <div className="absolute z-10 mt-1 flex min-w-56 items-center gap-1.5 rounded-lg border border-edge bg-surface p-1.5 shadow-lg">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveCurrent();
                }
              }}
              maxLength={60}
              placeholder="Name this scope"
              className="min-w-0 flex-1 rounded-md border border-edge bg-surface-2 px-2 py-1 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            />
            <button
              type="button"
              onClick={saveCurrent}
              disabled={!name.trim() || scopesBusy}
              className="rounded-md border border-edge-strong bg-accent-soft px-2.5 py-1 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-soft/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </details>
      )}

      {activeCount > 0 && (
        <span className="text-sm text-ink-muted">
          Showing {showing} of {rows.length}
        </span>
      )}
    </div>
  );
}
