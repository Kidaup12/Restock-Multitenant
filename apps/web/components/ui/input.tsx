import { cn } from "@/lib/cn";

/**
 * Two sizes, matching `Button` and `Select`.
 *
 * A minimum height alone does not make a short control: the padding decides,
 * so an inline `min-h-8` still rendered at 37px beside 32px buttons in a
 * control bar. The size has to carry its own padding and type, which is why a
 * caller cannot get there with a class.
 */
const sizes = {
  sm: "min-h-8 px-2.5 py-1.5 text-xs",
  md: "min-h-10 px-3.5 py-2.5 text-sm",
};

/** The native `size` attribute (a character count) is replaced by the control's
 *  own scale, so anything wrapping `Input` builds on this rather than on the
 *  raw input attributes. */
export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: keyof typeof sizes;
};

export function Input({ className, size = "md", ...rest }: InputProps) {
  return (
    <input
      className={cn(
        "w-full rounded-md border border-edge bg-surface text-ink transition-colors",
        sizes[size],
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
