"use client";

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
        <span
          className={cn(
            "text-center font-mono text-sm tabular-nums text-ink",
            valueClassName ?? "w-20",
          )}
        >
          {value}
        </span>
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
