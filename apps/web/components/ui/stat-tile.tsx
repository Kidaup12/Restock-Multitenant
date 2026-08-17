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

/**
 * The figure itself carries the verdict.
 *
 * Three stockouts is bad news and no stockouts is good news, and the tile can say
 * so in the number rather than making the reader parse a sub-line to find out.
 * Default is plain ink: most figures are neither.
 */
const valueTones = {
  default: "text-ink",
  positive: "text-positive",
  warning: "text-warning",
  negative: "text-negative",
  critical: "text-critical",
};

export function StatTile({
  label,
  value,
  valueTone = "default",
  delta,
  className,
}: {
  label: string;
  /* String, or an element like <CostValue> when the figure is gated. */
  value: React.ReactNode;
  valueTone?: keyof typeof valueTones;
  delta?: StatDelta;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-edge bg-surface p-4 shadow-card sm:p-5",
        className,
      )}
    >
      <div className="text-2xs tracking-wider text-ink-muted uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 font-mono text-3xl font-semibold tracking-tight",
          valueTones[valueTone],
        )}
      >
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
