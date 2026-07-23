import { cn } from "@/lib/cn";

const sizes = {
  sm: "size-4 border-2",
  md: "size-5 border-2",
  lg: "size-8 border-[3px]",
};

export function Spinner({
  size = "md",
  className,
}: {
  size?: keyof typeof sizes;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block animate-spin rounded-full border-accent-soft border-t-accent",
        sizes[size],
        className,
      )}
    />
  );
}
