import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/spinner";

/**
 * Ink is the primary action, not the accent.
 *
 * The accent is spent deliberately — roughly a tenth of any screen — so the
 * ordinary "go" button is near-black and `accent` is reserved for the one action
 * a screen is actually about. Every existing `primary` therefore turns from a
 * coloured button into an ink one, which is the intended shift and not a
 * regression: a page with six violet buttons had no way to say which mattered.
 *
 * `danger` has no counterpart in the reference; it stays, because destructive
 * actions still have to look destructive.
 */
const variants = {
  // Sits at body ink and deepens on press, so the hover intensifies rather than
  // fades. In dark that inverts to a near-white button brightening to white.
  primary: "bg-ink text-surface hover:bg-ink-strong active:bg-ink-strong",
  accent: "bg-accent text-on-accent hover:bg-accent-strong active:bg-accent-strong shadow-card",
  ghost:
    "border border-edge bg-surface text-ink hover:bg-surface-2 active:bg-surface-2",
  danger: "bg-negative text-on-accent hover:brightness-95",
};

const sizes = {
  sm: "h-8 px-3 text-xs",
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
