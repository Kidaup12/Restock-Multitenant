import Link from "next/link";
import { getDashboardTable } from "@/lib/data/today";
import { AbcBadge } from "@/components/ui/abc-badge";
import type { CatalogueRow } from "@/lib/data/stock";

/**
 * The week's buy banner: what the owner should restock now to protect sales.
 *
 * The forecast runs nightly, so this reads the LATEST run's reorder pile
 * (getDashboardTable's `reorder`, drawn from the buy list) and names the
 * essentials — the bestsellers and about-to-empty lines a stockout costs real
 * money on. It is the same data the board below shows, ordered the same way
 * (Class A → most urgent → soonest to empty), so the banner and the table can
 * never disagree about what to buy first.
 *
 * Informational, not a one-time guide: it appears whenever there ARE essentials
 * to buy and disappears when there are none — a healthy shop is not nagged. It
 * is about WHAT to buy (names, class, urgency, count), never cost, so it shows
 * for every role including money-blind members.
 */

/** How many example names to spell out before collapsing the rest into "+N more". */
const MAX_EXAMPLES = 4;

/** An "essential" is a reorder line a stockout would actually hurt: a Class A
 *  bestseller, or any line the run flags critical/high urgency. Class C with
 *  weeks of cover is a real reorder but not this week's must-buy — the whole
 *  point of the banner is to lift the few lines that protect sales to the top. */
function isEssential(row: CatalogueRow): boolean {
  return row.abc === "A" || row.urgency === "critical" || row.urgency === "high";
}

export async function BuyThisWeek({
  tenantId,
  canViewCosts,
}: {
  tenantId: string;
  canViewCosts: boolean;
}) {
  const data = await getDashboardTable(tenantId, { canViewCosts });

  // The reorder pile is already the planner's active buy list, ordered Class A →
  // urgency → soonest stockout. Filtering keeps that order, so the examples are
  // the top essentials by the exact priority the plan is acted on.
  const essentials = data.rows.reorder.filter(isEssential);

  // Healthy shop, or nothing urgent enough to be an essential: no banner.
  if (essentials.length === 0) return null;

  const shown = essentials.slice(0, MAX_EXAMPLES);
  const moreCount = essentials.length - shown.length;
  const isOne = essentials.length === 1;

  return (
    <section
      aria-label="Buy this week"
      className="rounded-lg border border-accent-200 bg-accent-soft px-5 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">
            Buy {isOne ? "this essential" : `these ${essentials.length} essentials`} this
            week to protect sales
          </h2>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Your bestsellers and about-to-empty lines from the latest forecast —
            the ones a stockout costs you real money on.
          </p>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {shown.map((row) => (
              <li
                key={row.productId}
                className="flex items-center gap-1.5 text-sm text-ink"
              >
                <AbcBadge value={row.abc} />
                <span className="truncate">{row.title}</span>
              </li>
            ))}
            {moreCount > 0 && (
              <li className="self-center text-sm text-ink-muted">
                +{moreCount} more
              </li>
            )}
          </ul>
        </div>
        <Link
          href="/plan"
          className="shrink-0 self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent shadow-card hover:bg-accent-strong active:bg-accent-strong"
        >
          Plan this week&apos;s buy &rarr;
        </Link>
      </div>
    </section>
  );
}
