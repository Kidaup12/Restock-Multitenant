import { cn } from "@/lib/cn";
import { InboxIcon } from "@/components/icons";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-edge-strong bg-surface px-6 py-16 text-center",
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-md bg-surface-2 text-ink-muted [&_svg]:size-6">
        {icon ?? <InboxIcon />}
      </div>
      <h2 className="mt-4 font-display text-base font-semibold text-ink">
        {title}
      </h2>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
