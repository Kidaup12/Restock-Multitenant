import { cn } from "@/lib/cn";

export function Input({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-10 w-full rounded-md border border-edge bg-surface px-3.5 py-2.5 text-sm text-ink transition-colors",
        "placeholder:text-ink-faint",
        // Focus is a tinted halo plus a coloured edge, not an outline ring.
        "outline-none focus:border-accent-500 focus:ring-4 focus:ring-accent-100",
        "disabled:pointer-events-none disabled:opacity-60",
        "aria-[invalid=true]:border-negative aria-[invalid=true]:focus:ring-negative-soft",
        className,
      )}
      {...rest}
    />
  );
}
