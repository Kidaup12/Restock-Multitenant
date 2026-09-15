import { getLeakageMatrix } from "@/lib/data/insights";
import { LeakageMatrixView } from "./leakage-matrix-view";

/**
 * "Where it's leaking" — the category / ABC leakage matrix.
 *
 * The server component's only job is to fetch: the toggle between the two cuts
 * is client state (see leakage-matrix-view.tsx), so both `byCategory` and
 * `byAbc` are handed over already-loaded and the flip happens without a round
 * trip. Capital tied up is a cost — the loader nulls it for a money-blind
 * caller, and the view drops the column, so nothing owner-only crosses the
 * boundary here.
 */
export async function LeakageMatrixSection({
  tenantId,
  currency,
  weeks,
  canViewCosts,
}: {
  tenantId: string;
  currency: string;
  /** Weeks to cover, from the report's period. */
  weeks: number;
  canViewCosts: boolean;
}) {
  const { byCategory, byAbc, windowDays } = await getLeakageMatrix(tenantId, {
    weeks,
    canViewCosts,
  });

  return (
    <LeakageMatrixView
      byCategory={byCategory}
      byAbc={byAbc}
      windowDays={windowDays}
      canViewCosts={canViewCosts}
      currency={currency}
    />
  );
}
