import { cn } from "@/lib/cn";

/**
 * A determinate bar when the total is known, an indeterminate one when it isn't.
 * The distinction is the point: a long wait with no denominator (a fetch that
 * hasn't returned) must look like "working", not like a bar stuck at zero.
 */
export function Progress({
  value,
  max,
  label,
  className,
}: {
  /** Units done. Ignored when `max` is null. */
  value?: number;
  /** Units expected; null or undefined renders the indeterminate track. */
  max?: number | null;
  label: string;
  className?: string;
}) {
  const determinate = typeof max === "number" && max > 0 && typeof value === "number";
  const pct = determinate ? Math.min(100, Math.max(0, (value! / max!) * 100)) : null;

  return (
    <div
      role="progressbar"
      aria-label={label}
      {...(determinate
        ? { "aria-valuenow": Math.round(pct!), "aria-valuemin": 0, "aria-valuemax": 100 }
        : {})}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
    >
      {determinate ? (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="progress-indeterminate h-full w-1/4 rounded-full bg-accent" />
      )}
    </div>
  );
}
