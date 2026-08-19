"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A minus / value / plus control for a bounded number.
 *
 * Six copies of this markup existed across the planner — two horizon lenses on
 * the checklist, the cover target on the budget allocator — and they had already
 * drifted on the width of the value slot, which is the one measurement that has
 * to hold or the row jitters as the number changes.
 *
 * The value is a node rather than a number so a caller can render its own unit
 * ("30 days", "+10%") without this component knowing what is being counted.
 *
 * Pass `edit` and the reading becomes typeable as well as steppable. Nine clicks
 * to get from 21 days to 45 is not a control, it is an obstacle — but the unit
 * still has to render, so the caller hands over the bare number and the word
 * separately rather than this trying to parse "30 days" back apart.
 */
export function Stepper({
  label,
  value,
  onDecrement,
  onIncrement,
  decrementLabel,
  incrementLabel,
  canDecrement = true,
  canIncrement = true,
  busy = false,
  valueClassName,
  edit,
}: {
  /** Names the control beside the buttons. */
  label: string;
  value: React.ReactNode;
  onDecrement: () => void;
  onIncrement: () => void;
  /** What each button does, for anyone who can't see the sign. */
  decrementLabel: string;
  incrementLabel: string;
  canDecrement?: boolean;
  canIncrement?: boolean;
  /** A step is in flight — both buttons rest until it lands. */
  busy?: boolean;
  /** Widen the value slot when the longest reading needs it. */
  valueClassName?: string;
  /** Makes the reading typeable. Omit for a step-only control. */
  edit?: {
    /** The bare number, without its unit. */
    value: number;
    min: number;
    max: number;
    /** Committed on blur and on Enter, already clamped to [min, max]. */
    onCommit: (next: number) => void;
    /** Rendered after the field, so the reading still says what it counts. */
    unit?: string;
    ariaLabel: string;
  };
}) {
  const button =
    "grid size-7 place-items-center rounded-sm border border-edge text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-ink">{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDecrement}
          disabled={busy || !canDecrement}
          aria-label={decrementLabel}
          className={button}
        >
          −
        </button>
        {edit ? (
          <EditableValue edit={edit} busy={busy} className={valueClassName} />
        ) : (
          <span
            className={cn(
              "text-center font-mono text-sm tabular-nums text-ink",
              valueClassName ?? "w-20",
            )}
          >
            {value}
          </span>
        )}
        <button
          type="button"
          onClick={onIncrement}
          disabled={busy || !canIncrement}
          aria-label={incrementLabel}
          className={button}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * What a typed reading commits to, or null to restore what was there.
 *
 * Null rather than a fallback number on purpose: an empty field is not zero
 * days of cover, and text is not a quantity. Both mean "the owner did not
 * finish", and the honest response is to put the previous reading back rather
 * than plan against something nobody chose. Out-of-range IS an answer, so it
 * clamps instead of refusing.
 */
export function committedValue(draft: string, min: number, max: number): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * The typeable reading.
 *
 * Draft text is held locally so a half-typed "4" on the way to "45" is not
 * committed and re-planned; the value only leaves on blur or Enter. Escape
 * abandons the edit, and anything that is not a number falls back to the value
 * that was there — a cleared field must not read as zero days of cover.
 */
function EditableValue({
  edit,
  busy,
  className,
}: {
  edit: NonNullable<Parameters<typeof Stepper>[0]["edit"]>;
  busy: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(edit.value));
  const [shown, setShown] = useState(edit.value);

  // The buttons change the same number, so the field follows them. Adjusted
  // during render rather than in an effect: an effect would paint the stale
  // reading first and correct it on a second pass, which is visible on a
  // control someone is holding down.
  if (edit.value !== shown) {
    setShown(edit.value);
    setDraft(String(edit.value));
  }

  function commit() {
    const next = committedValue(draft, edit.min, edit.max);
    if (next == null) {
      setDraft(String(edit.value));
      return;
    }
    setDraft(String(next));
    if (next !== edit.value) edit.onCommit(next);
  }

  return (
    <span className={cn("flex items-center justify-center gap-1", className ?? "w-20")}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(String(edit.value));
            e.currentTarget.blur();
          }
        }}
        disabled={busy}
        inputMode="numeric"
        aria-label={edit.ariaLabel}
        className="w-9 rounded-sm border border-edge bg-surface px-1 py-0.5 text-center font-mono text-sm tabular-nums text-ink outline-none transition-colors focus:border-accent-500 focus:ring-4 focus:ring-accent-100 disabled:opacity-40"
      />
      {edit.unit && <span className="font-mono text-sm text-ink-muted">{edit.unit}</span>}
    </span>
  );
}
