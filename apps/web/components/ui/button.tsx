import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/spinner";

const variants = {
  primary: "bg-accent text-on-accent hover:bg-accent-strong",
  ghost:
    "border border-edge bg-surface text-ink-secondary hover:bg-surface-2 hover:text-ink",
  danger: "bg-negative text-on-accent hover:brightness-95",
};

const sizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
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
        "relative inline-flex items-center justify-center rounded-md font-medium transition-colors",
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
