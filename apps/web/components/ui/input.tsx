import { cn } from "@/lib/cn";

export function Input({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-edge bg-surface px-3 text-sm text-ink transition-colors",
        "placeholder:text-ink-faint",
        "outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:pointer-events-none disabled:opacity-60",
        "aria-[invalid=true]:border-negative",
        className,
      )}
      {...rest}
    />
  );
}
