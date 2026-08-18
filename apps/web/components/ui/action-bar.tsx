import { cn } from "@/lib/cn";

/**
 * The bar that follows a selection down a long list — "12 ticked · KES 84,000"
 * on the left, the action that commits them on the right.
 *
 * It sticks rather than sitting at the end of the table because the decision is
 * made while scrolling: on a 400-row catalogue the button would otherwise be
 * somewhere the reader has to go and find, after they have already decided.
 *
 * Three screens had built this from the same class string. It is one component so
 * the offset from the bottom, the elevation and the padding cannot drift — and a
 * change to any of them reaches every list at once.
 */
export function ActionBar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface px-5 py-3 shadow-pop",
        className,
      )}
    >
      {children}
    </div>
  );
}
