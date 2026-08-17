import { cn } from "@/lib/cn";
import { TrendDownIcon, TrendUpIcon } from "@/components/icons";

const deltaTones = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-ink-muted",
};

export type StatDelta = {
  label: string;
  tone: keyof typeof deltaTones;
  direction?: "up" | "down";
};

export function StatTile({
  label,
  value,
  delta,
  icon,
  className,
}: {
  label: string;
  /* String, or an element like <CostValue> when the figure is gated. */
  value: React.ReactNode;
  delta?: StatDelta;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative rounded-lg border border-edge bg-surface p-4 shadow-card sm:p-5",
        className,
      )}
    >
      {icon && (
        <div className="absolute top-4 right-4 grid size-9 place-items-center rounded-md bg-accent-soft text-accent-ink [&_svg]:size-4.5">
          {icon}
        </div>
      )}
      <div className="text-2xs tracking-wider text-ink-muted uppercase">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-3xl font-semibold tracking-tight text-ink">
        {value}
      </div>
      {delta && (
        <div
          className={cn(
            "mt-1 flex items-center gap-1 text-2xs font-medium",
            deltaTones[delta.tone],
          )}
        >
          {delta.direction === "up" && <TrendUpIcon className="size-3.5" />}
          {delta.direction === "down" && <TrendDownIcon className="size-3.5" />}
          <span>{delta.label}</span>
        </div>
      )}
    </div>
  );
}
