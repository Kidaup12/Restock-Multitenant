import { cn } from "@/lib/cn";
import { ChevronDownIcon } from "@/components/icons";

/**
 * A styled `<select>`, matching `Input` exactly.
 *
 * A bare `<select>` takes the operating system's own chrome — the wrong corner
 * radius, the wrong arrow, the wrong focus ring — and on Windows it sits visibly
 * apart from every other control on the form. The native element is kept for its
 * behaviour and accessibility; only the painting is ours, with `appearance-none`
 * removing the OS arrow and a chevron drawn in its place.
 *
 * The chevron is inert (`pointer-events-none`) so the whole control still opens
 * the menu wherever it is clicked.
 */
export function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(
          "min-h-10 w-full appearance-none rounded-md border border-edge bg-surface py-2.5 pr-9 pl-3.5 text-sm text-ink transition-colors",
          "outline-none focus:border-accent-500 focus:ring-4 focus:ring-accent-100",
          "disabled:pointer-events-none disabled:opacity-60",
          "aria-[invalid=true]:border-negative aria-[invalid=true]:focus:ring-negative-soft",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-muted [&_svg]:size-3.5"
      >
        <ChevronDownIcon />
      </span>
    </div>
  );
}
