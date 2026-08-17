import { cn } from "@/lib/cn";

/**
 * A tinted chip, not an outlined pill: the tone carries a wash of its own colour
 * at low opacity and the text in the full-strength version of it. `critical` is
 * the fourth level — "already losing money", above `negative`'s "at risk".
 */
const tones = {
  neutral: "bg-surface-2 text-ink-muted",
  accent: "bg-accent-soft text-accent-ink",
  positive: "bg-positive/10 text-positive",
  warning: "bg-warning/10 text-warning",
  negative: "bg-negative/10 text-negative",
  critical: "bg-critical/10 text-critical",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: keyof typeof tones;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-xs px-2 py-0.5 text-2xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
