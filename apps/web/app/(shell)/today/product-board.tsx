import Link from "next/link";
import { getDashboardTable } from "@/lib/data/today";
import { ProductTabs } from "./product-tabs";

/**
 * The board that fills the middle of Today: the four figures, the trend beside
 * the health list, and the table under them.
 *
 * One read serves all of it. The critical warning rides along because it counts
 * off the same buy list the Reorder pile is drawn from — sourcing it separately
 * would run that query twice for a number that is already here.
 */
export async function ProductBoard({
  tenantId,
  canViewCosts,
  trend,
}: {
  tenantId: string;
  canViewCosts: boolean;
  trend: React.ReactNode;
}) {
  const data = await getDashboardTable(tenantId, { canViewCosts });

  return (
    <div className="space-y-6">
      {data.criticalCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-accent-soft p-3 text-sm text-accent-ink">
          <span>
            <span className="font-medium">
              {data.criticalCount} critical{" "}
              {data.criticalCount === 1 ? "item is" : "items are"} at or near zero stock
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
