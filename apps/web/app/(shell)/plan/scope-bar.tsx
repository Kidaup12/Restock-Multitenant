"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { HelpTip } from "@/components/ui/help-tip";
import { MultiPicker } from "@/components/ui/multi-picker";
import { abcTone } from "@/components/ui/abc-badge";
import { cn } from "@/lib/cn";
import type { BuyListRow } from "@/lib/data/plan";
// The "no value" sentinel is shared with the catalogue facets so scoping to a
// gap (uncategorised, no supplier, unranked) reads the same everywhere.
import { NONE_VALUE } from "@/lib/facets/types";
import type { SavedScope } from "./scope-actions";

/**
 * Filter card for the buy list: narrow it by supplier, sales class, lead time
 * and category. Every dimension is metadata already on the row — no cost figure
 * enters here, so a money-blind member scopes exactly the list an owner does.
 *
 * Always open. It used to fold behind one small "Filter" button, with suppliers
 * a further click down in a popover that never closed — the control a buyer
 * reaches for first was the hardest to reach. Supplier now leads as a
 * searchable picker; class and lead time are one-click toggles, each with a
 * "?" that says what it means.
 *
 * Filtering is AND across dimensions, OR within one (matching the catalogue's
 * facet bar). Options are derived from the rows on screen, never hard-coded, so
 * a dimension with fewer than two values drops out — nothing to filter by.
 */

import { LEAD_BANDS, LEAD_BAND_LABELS, leadBandFor, EMPTY_SCOPE, type LeadBand, type ScopeSelection } from "./scope";
export { LEAD_BANDS, LEAD_BAND_LABELS, leadBandFor, EMPTY_SCOPE, isScopeActive, parseScopeFromParams, scopeToParams, SCOPE_PARAM_NAMES, matchesScope, isUrgentRow, filterBuyListRows, type LeadBand, type ScopeSelection } from "./scope";

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

/**
 * Plain names for the classes. "Class A" is jargon an owner has to be taught;
 * "best sellers" is how they already think — the letter stays beside it for
 * anyone who has learnt it. The same names the catalogue's class chips use.
 */
const CLASS_NAMES: Record<string, string> = {
  A: "Best sellers",
  B: "Steady sellers",
  C: "Slow movers",
};

/** Selected reads as a solid accent outline plus a tick, so "which are on"
 *  never depends on telling two pastel tints apart. An unselected chip carries
 *  its meaning in a small coloured dot instead of a tinted body. */
const ABC_DOT: Record<"critical" | "warning" | "neutral", string> = {
  critical: "bg-critical",
  warning: "bg-warning",
  neutral: "bg-ink-faint",
};
const LEAD_DOT: Record<LeadBand, string> = {
  fast: "bg-positive",
  medium: "bg-accent",
  slow: "bg-warning",
};

const LEAD_NAMES: Record<LeadBand, { name: string; range: string }> = {
  fast: { name: "Fast", range: "up to 7 days" },
  medium: { name: "Medium", range: "8–28 days" },
  slow: { name: "Slow", range: "over 28 days" },
};

/** Close a popover on a click outside it or on Escape. */
function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

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
  const activeCount =
    selection.abc.length + selection.category.length + selection.supplier.length + selection.leadBand.length;

  function set(key: ScopeDimension, next: string[]) {
    onChange({ ...selection, [key]: next });
  }
  function toggle(key: ScopeDimension, value: string) {
    const current = selection[key] as string[];
    set(key, current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  }

  // A dimension with a single value has nothing to choose between.
  const has = (key: ScopeDimension) => facets[key].length > 1;
  if (!has("abc") && !has("category") && !has("supplier") && !has("leadBand")) return null;

  // Every chosen value as a removable pill, so what is narrowing the list reads
  // in one place — including values folded inside a picker.
  const pills: { key: ScopeDimension; value: string; text: string }[] = [
    ...selection.supplier.map((v) => ({ key: "supplier" as const, value: v, text: v === NONE_VALUE ? "No supplier" : v })),
    ...selection.abc.map((v) => ({ key: "abc" as const, value: v, text: CLASS_NAMES[v] ?? (v === NONE_VALUE ? "Unranked" : v) })),
    ...selection.leadBand.map((v) => ({ key: "leadBand" as const, value: v, text: `${LEAD_NAMES[v].name} lead time` })),
    ...selection.category.map((v) => ({ key: "category" as const, value: v, text: v === NONE_VALUE ? "Uncategorised" : v })),
  ];

  return (
    <section aria-label="Filter the buy list" className="rounded-lg border border-edge bg-surface shadow-card">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4 p-4">
        {has("supplier") && (
          <FilterField
            label="Supplier"
            className="w-full sm:w-64"
            help="Show only what you buy from these suppliers — the quickest way to build one supplier's order. Tick as many as you like, or type to find one."
          >
            <MultiPicker
              label="Supplier"
              allLabel="All suppliers"
              searchPlaceholder="Search suppliers…"
              options={facets.supplier}
              selected={selection.supplier}
              onChange={(next) => set("supplier", next)}
            />
          </FilterField>
        )}

        {has("abc") && (
          <FilterField
            label="Sales class"
            help={
              <>
                Products ranked by how much money they bring in.
                <span className="mt-1.5 block"><b className="text-ink">Best sellers (A)</b> — the top ~70% of your sales value. Never let these run out.</span>
                <span className="block"><b className="text-ink">Steady sellers (B)</b> — the next ~20%.</span>
                <span className="block"><b className="text-ink">Slow movers (C)</b> — the long tail. Buy sparingly.</span>
              </>
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {facets.abc.map((opt) => (
                <ToggleChip
                  key={opt.value}
                  on={selection.abc.includes(opt.value)}
                  onClick={() => toggle("abc", opt.value)}
                  dot={opt.value === NONE_VALUE ? undefined : ABC_DOT[abcTone(opt.value)]}
                  count={opt.count}
                >
                  {opt.value === NONE_VALUE ? "Unranked" : (CLASS_NAMES[opt.value] ?? opt.label)}
                  {opt.value !== NONE_VALUE && <span className="ml-1 text-ink-faint">{opt.value}</span>}
                </ToggleChip>
              ))}
            </div>
          </FilterField>
        )}

        {has("leadBand") && (
          <FilterField
            label="Lead time"
            help="How long the supplier takes to deliver after you order. Slow-lead items need ordering earliest — the plan already counts each item's lead time in its order-by date and its quantity."
          >
            <div className="flex flex-wrap gap-1.5">
              {facets.leadBand.map((opt) => {
                const band = opt.value as LeadBand;
                return (
                  <ToggleChip
                    key={opt.value}
                    on={selection.leadBand.includes(band)}
                    onClick={() => toggle("leadBand", opt.value)}
                    dot={LEAD_DOT[band]}
                    count={opt.count}
                  >
                    {LEAD_NAMES[band].name}
                    <span className="ml-1 text-ink-faint">{LEAD_NAMES[band].range}</span>
                  </ToggleChip>
                );
              })}
            </div>
          </FilterField>
        )}

        {has("category") && (
          <FilterField
            label="Category"
            className="w-full sm:w-56"
            help="Show only these product categories, as set on your products in Shopify."
          >
            <MultiPicker
              label="Category"
              allLabel="All categories"
              searchPlaceholder="Search categories…"
              options={facets.category}
              selected={selection.category}
              onChange={(next) => set("category", next)}
            />
          </FilterField>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-b-lg border-t border-edge bg-surface-2/40 px-4 py-2.5">
        <span className="text-sm text-ink-secondary">
          {activeCount > 0 ? (
            <>
              Showing <b className="font-semibold text-ink tabular-nums">{showing}</b> of{" "}
              <span className="tabular-nums">{rows.length}</span> products
            </>
          ) : (
            <>
              All <b className="font-semibold text-ink tabular-nums">{rows.length}</b> products to restock
            </>
          )}
        </span>
        {pills.map((p) => (
          <button
            key={`${p.key}:${p.value}`}
            type="button"
            onClick={() => toggle(p.key, p.value)}
            aria-label={`Remove filter ${p.text}`}
            className="inline-flex items-center gap-1 rounded-full border border-accent-200 bg-accent-soft py-0.5 pr-1.5 pl-2.5 text-xs font-medium text-accent-ink transition-colors hover:border-accent-500"
          >
            {p.text}
            <span aria-hidden className="text-sm leading-none">×</span>
          </button>
        ))}
        {activeCount > 0 && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_SCOPE)}
            className="rounded-sm px-2 py-1 text-xs font-medium text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Clear all
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {savedScopes.length > 0 && (
            <SavedViews savedScopes={savedScopes} onApply={onChange} onDelete={onDeleteScope} />
          )}
          {onSaveScope && activeCount > 0 && <SaveView onSave={onSaveScope} busy={scopesBusy} />}
        </span>
      </div>
    </section>
  );
}

/** One labelled filter, its "?" explainer beside the label. */
function FilterField({
  label,
  help,
  className,
  children,
}: {
  label: string;
  help: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        {label}
        <HelpTip label={`What is ${label.toLowerCase()}?`}>{help}</HelpTip>
      </div>
      {children}
    </div>
  );
}

/** A filter value clicked on and off — big enough to hit, with its count so a
 *  reader can see what narrowing costs before they click. */
function ToggleChip({
  on,
  onClick,
  dot,
  count,
  children,
}: {
  on: boolean;
  onClick: () => void;
  dot?: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        on
          ? "border-accent-500 bg-accent-soft font-medium text-accent-ink ring-1 ring-accent-500"
          : "border-edge-strong bg-surface text-ink hover:border-accent-500 hover:bg-surface-2"
      )}
    >
      {on ? (
        <span aria-hidden className="grid size-3.5 place-items-center rounded-full bg-accent text-[9px] leading-none text-on-accent">
          ✓
        </span>
      ) : (
        dot && <span aria-hidden className={cn("size-2 rounded-full", dot)} />
      )}
      <span>{children}</span>
      <span className="rounded-full bg-surface-2 px-1.5 font-mono text-xs tabular-nums text-ink-muted">{count}</span>
    </button>
  );
}

function SavedViews({
  savedScopes,
  onApply,
  onDelete,
}: {
  savedScopes: SavedScope[];
  onApply: (selection: ScopeSelection) => void;
  onDelete?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-md border border-edge-strong bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:border-accent-500"
      >
        Saved views
        <span className="rounded-full bg-surface-2 px-1.5 font-mono tabular-nums text-ink-muted">{savedScopes.length}</span>
        <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1.5 flex max-h-72 w-64 flex-col gap-0.5 overflow-auto rounded-lg border border-edge bg-surface p-1.5 shadow-pop">
          {savedScopes.map((scope) => (
            <div key={scope.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onApply(scope.selection);
                  setOpen(false);
                }}
                className="min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-left text-sm text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
              >
                {scope.name}
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(scope.id)}
                  aria-label={`Delete saved view ${scope.name}`}
                  className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-negative"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SaveView({ onSave, busy }: { onSave: (name: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName("");
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-8 items-center rounded-md border border-edge-strong bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:border-accent-500"
      >
        Save this view
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1.5 flex w-72 items-center gap-1.5 rounded-lg border border-edge bg-surface p-2 shadow-pop">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            maxLength={60}
            placeholder="e.g. Orbit Imports best sellers"
            className="min-w-0 flex-1 rounded-md border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent-500 focus:ring-4 focus:ring-accent-100"
          />
          <button
            type="button"
            onClick={save}
            disabled={!name.trim() || busy}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
