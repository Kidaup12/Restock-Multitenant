import Link from "next/link";
import { getCostCoverage } from "@/lib/data/costs";

/**
 * The two things that stop the buy list being trustworthy, said where the shop
 * looks first, each with the screen that fixes it.
 *
 * Both counts come from the getter that already owns them rather than a second
 * query of my own: a bar reading "12 products need a cost" that links to a
 * filtered catalogue showing 9 is worse than no bar at all.
 */

/**
 * Products the catalogue would flag `missing_cost`.
 *
 * `resolveCost` treats any stored cost <= 0 as missing whatever its label says
 * (`lib/cost/resolve.ts:70-72`), which is the same predicate as the health flag
 * behind `/stock?issue=missing_cost` (`lib/facets/health.ts:65`) — so this
 * count and that screen always agree.
 *
 * Owner-only, and not because of the money figure: the catalogue deliberately
 * strips the `missing_cost` chip from a money-blind member
 * (`lib/data/stock.ts:258-265`), because a filter selecting exactly the
 * products with no cost IS a cost fact. A bar counting them would hand back
 * what that strip hides.
 */
export async function CostGapBar({
  tenantId,
  canViewCosts,
}: {
  tenantId: string;
  canViewCosts: boolean;
}) {
  if (!canViewCosts) return null;

  const coverage = await getCostCoverage(tenantId, { canViewCosts });
  const missing = coverage.sourceSplit.missing;
  if (missing === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning bg-warning-soft p-3 text-sm text-warning">
      <span>
        <span className="font-medium">
          {missing} {missing === 1 ? "product needs" : "products need"} a cost
        </span>{" "}
        — they stay off the buy list until one is set.
      </span>
      <Link
        href="/stock?issue=missing_cost"
        className="font-medium underline-offset-2 hover:underline"
      >
        Fix costs →
      </Link>
    </div>
  );
}
