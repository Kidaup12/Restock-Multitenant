import { cn } from "@/lib/cn";

/* Label + control + inline error. `hint` renders opposite the label (e.g. a
   "Forgot password?" link). */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-2xs font-medium tracking-wider text-ink-muted uppercase">
          {label}
        </label>
        {hint}
      </div>
      {children}
      {error && (
        <p role="alert" className="text-2xs text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
