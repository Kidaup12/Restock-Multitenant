import Link from "next/link";
import { abcTone } from "@/components/ui/abc-badge";
import { cn } from "@/lib/cn";
import type { TransferScope, TransferScopeFacets, TransferScopeOption } from "@/lib/data/transfers";

/**
 * Narrow the live proposal by ABC class and/or category — the same two
 * dimensions the buy list's scope bar offers, sized down to what a transfer
 * line actually carries (no supplier/lead-time facet here). Options and their
 * counts always describe the FULL set of products this source could ship —
 * never the caller's current selection — so a chosen chip is never the thing
 * that makes itself, or a sibling, disappear.
 */

const ABC_TINT: Record<"critical" | "warning" | "neutral", string> = {
  critical: "border-critical/20 bg-critical/10 text-critical hover:bg-critical/15",
  warning: "border-warning/20 bg-warning/10 text-warning hover:bg-warning/15",
  neutral: "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink",
};

function Chip({
  option,
  on,
  tint,
  href,
}: {
  option: TransferScopeOption;
  on: boolean;
  tint?: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={on ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors",
        on
          ? "border-accent-200 bg-accent-soft text-accent-ink"
          : (tint ?? "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink"),
      )}
    >
      {option.label}
      <span className="rounded-xs bg-surface-2/70 px-1.5 font-mono tabular-nums">{option.count}</span>
    </Link>
  );
}

export function TransferScopeChips({
  facets,
  selection,
  hrefFor,
}: {
  facets: TransferScopeFacets;
  selection: TransferScope;
  hrefFor: (next: { abc?: string[]; category?: string[] }) => string;
}) {
  if (facets.abc.length === 0 && facets.category.length === 0) return null;

  function toggle(dim: "abc" | "category", value: string): string {
    const current = selection[dim];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    return hrefFor({ [dim]: next });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {facets.abc.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs font-medium text-ink-muted">Class</span>
          {facets.abc.map((opt) => (
            <Chip
              key={opt.value}
              option={opt}
              on={selection.abc.includes(opt.value)}
              tint={ABC_TINT[abcTone(opt.value)]}
              href={toggle("abc", opt.value)}
            />
          ))}
        </div>
      )}
      {facets.category.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs font-medium text-ink-muted">Category</span>
          {facets.category.map((opt) => (
            <Chip
              key={opt.value}
              option={opt}
              on={selection.category.includes(opt.value)}
              href={toggle("category", opt.value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
