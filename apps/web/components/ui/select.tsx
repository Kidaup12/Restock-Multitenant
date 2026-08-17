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
/**
 * Two sizes, for the same reason `Button` has two: a 40px control inside a table
 * row pushes the row height out and costs the density the tables rely on. `sm` is
 * the same control a step down, not a different one.
 */
const sizes = {
  sm: { field: "min-h-8 py-1.5 pr-8 pl-2.5 text-xs", chevron: "right-2.5 [&_svg]:size-3" },
  md: { field: "min-h-10 py-2.5 pr-9 pl-3.5 text-sm", chevron: "right-3 [&_svg]:size-3.5" },
};

/* `size` shadows the native select attribute (a row count, which means nothing
 * for a dropdown). Ours is the control's scale, so the native one is dropped
 * rather than intersected — the two together resolve to `never`. */
export function Select({
  size = "md",
  className,
  children,
  ...rest
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: keyof typeof sizes;
}) {
  return (
    <div className="relative">
      <select
        className={cn(
          "w-full appearance-none rounded-md border border-edge bg-surface text-ink transition-colors",
          "outline-none focus:border-accent-500 focus:ring-4 focus:ring-accent-100",
          "disabled:pointer-events-none disabled:opacity-60",
          "aria-[invalid=true]:border-negative aria-[invalid=true]:focus:ring-negative-soft",
          sizes[size].field,
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 flex items-center text-ink-muted",
          sizes[size].chevron,
        )}
      >
        <ChevronDownIcon />
      </span>
    </div>
  );
}
