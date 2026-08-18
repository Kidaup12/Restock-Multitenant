import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/spinner";

/**
 * The accent carries the primary action.
 *
 * Measured off the reference rather than inferred: its create action renders at
 * the accent, secondary actions are white with an edge, and ink is reserved for
 * the active segment in a tab strip. An earlier reading had this backwards and
 * made every primary near-black, which left the accent unused across the whole
 * app — the screens went quiet in the one place the reference is loud.
 *
 * Screens hold to one primary each; the rest are `ghost`. `danger` has no
 * counterpart there and stays, because destructive actions still have to look
 * destructive.
 */
const variants = {
  // Accent at rest, deepening on press. The shadow is the reference's own —
  // the same one-pixel lift the cards carry.
  primary:
    "bg-accent text-on-accent hover:bg-accent-strong active:bg-accent-strong shadow-card",
  ghost:
    "border border-edge bg-surface text-ink hover:bg-surface-2 active:bg-surface-2",
  danger: "bg-negative text-on-accent hover:brightness-95",
};

/**
 * Two sizes where the reference has one.
 *
 * Their button is a single 40px control, but three quarters of ours are `sm` and
 * most of those sit inside table rows and control strips where a 40px button
 * would push the row height out and break the density the tables depend on. So
 * `sm` stays, built from the same parts — same radius, same press, padding and
 * type scaled down a step — rather than being a different kind of button.
 */
const sizes = {
  sm: "min-h-8 px-3 py-1.5 text-xs",
  md: "min-h-10 px-4 py-2.5 text-sm",
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex items-center justify-center rounded-md font-medium",
        // Every button feels the press: a short ease-out scale, transform only.
        "transition-[transform,background-color,color,border-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
        "outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:pointer-events-none disabled:opacity-60",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {/* Label keeps its box while loading so the button width is preserved. */}
      <span
        className={cn("inline-flex items-center gap-2", loading && "invisible")}
      >
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner
            size="sm"
            className={variant === "ghost" ? undefined : "border-on-accent/30 border-t-on-accent"}
          />
        </span>
      )}
    </button>
  );
}
