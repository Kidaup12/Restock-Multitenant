import Link from "next/link";
import { getDashboardTable } from "@/lib/data/today";
import { formatMoney } from "@/lib/money";
import { ProductTabs } from "./product-tabs";

/**
 * The board that fills the middle of Today: the four figures, the trend beside
 * the health list, and the table under them.
 *
 * One read serves all of it. The critical warning rides along because it counts
 * off the same buy list the Reorder pile is drawn from — sourcing it separately
 * would run that query twice for a number that is already here.
 *
 * It says "run out within a week" and not "at or near zero stock" because that
 * is what it counts: a buy-list row is critical when it has under seven days of
 * cover and sells at a meaningful pace. The Stockouts tile below counts empty
 * shelves. Both numbers were right; giving them the same words made 4 and 3 read
 * as a contradiction on one screen.
 */
export async function ProductBoard({
  tenantId,
  canViewCosts,
  currency,
  trend,
}: {
  tenantId: string;
  canViewCosts: boolean;
  currency: string;
  trend: React.ReactNode;
}) {
  const data = await getDashboardTable(tenantId, { canViewCosts });

  return (
    <div className="space-y-6">
      {data.criticalCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-accent-soft p-3 text-sm text-accent-ink">
          <span>
            <span className="font-medium">
              {data.criticalCount} {data.criticalCount === 1 ? "item runs" : "items run"} out
              within a week
              {/* The money is what makes this a decision rather than an alarm:
                  a count says how many fires there are, the figure says whether
                  the shop can put them out this week. */}
              {data.criticalCostKes != null && data.criticalCostKes > 0 && (
                <> · about {formatMoney(data.criticalCostKes, currency, { compact: true })} to restock</>
              )}
            </span>{" "}
            — quantities account for cover, lead time and what is already on the way.
          </span>
          <Link
            href="/plan?mode=list&urgent=1"
            className="font-medium underline-offset-2 hover:underline"
          >
            Reorder critical →
          </Link>
        </div>
      )}
      <ProductTabs data={data} canViewCosts={canViewCosts} trend={trend} />
    </div>
  );
}
