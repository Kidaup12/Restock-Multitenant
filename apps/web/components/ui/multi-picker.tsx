"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export type PickerOption = { value: string; label: string; count: number };

/**
 * A searchable, tick-to-choose dropdown for a long list of values (suppliers,
 * categories).
 *
 * Replaces a `<details>` popover of chips, which never closed when you clicked
 * away, had no search, and showed a shop with forty suppliers a wall of pills.
 * This one has a search box, a tick per row with its count, "Select all
 * shown" / "Clear", and closes on Escape or a click elsewhere.
 */
export function MultiPicker({
  label,
  allLabel,
  options,
  selected,
  onChange,
  searchPlaceholder = "Search…",
  className,
}: {
  /** Names the dimension, used in the trigger and for screen readers. */
  label: string;
  /** What the trigger reads with nothing chosen ("All suppliers"). */
  allLabel: string;
  options: PickerOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const labelOf = (value: string) => options.find((o) => o.value === value)?.label ?? value;
  const triggerText =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? labelOf(selected[0]!)
        : `${labelOf(selected[0]!)} +${selected.length - 1}`;

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${triggerText}`}
        className={cn(
          "flex h-9 w-full min-w-48 items-center justify-between gap-2 rounded-md border px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          selected.length > 0
            ? "border-accent-500 bg-accent-soft text-accent-ink"
            : "border-edge-strong bg-surface text-ink hover:border-accent-500"
        )}
      >
        <span className="truncate">{triggerText}</span>
        <span className="flex items-center gap-1.5">
          {selected.length > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-on-accent tabular-nums">
              {selected.length}
            </span>
          )}
          <ChevronDownIcon className={cn("size-4 text-ink-muted transition-transform", open && "rotate-180")} />
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-edge bg-surface shadow-pop">
          <div className="border-b border-edge p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={`Search ${label.toLowerCase()}`}
              className="w-full rounded-md border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent-500 focus:ring-4 focus:ring-accent-100"
            />
          </div>
          <ul role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-72 overflow-auto p-1">
            {shown.length === 0 && <li className="px-2.5 py-2 text-sm text-ink-muted">No match for “{query}”.</li>}
            {shown.map((opt) => {
              const on = selected.includes(opt.value);
              return (
                <li key={opt.value} role="option" aria-selected={on}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-surface-2",
                      on ? "text-ink font-medium" : "text-ink-secondary"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(opt.value)}
                      className="size-4 shrink-0 rounded border-edge accent-accent"
                    />
                    <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    <span className="font-mono text-xs tabular-nums text-ink-faint">{opt.count}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-edge px-2 py-1.5">
            <button
              type="button"
              onClick={() => onChange([...new Set([...selected, ...shown.map((o) => o.value)])])}
              className="rounded-sm px-2 py-1 text-xs font-medium text-accent-ink hover:bg-accent-soft"
            >
              Select all{query ? " shown" : ""}
            </button>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onChange([])}
                disabled={selected.length === 0}
                className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:text-ink disabled:opacity-40"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-sm bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-strong"
              >
                Done
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
