import { prismaForTenant } from "@wezesha/db";
import { planFreshnessLabel } from "@/lib/data/forecast-freshness";

/**
 * When the buy list was last computed, said on the screen the shop opens first.
 *
 * It was only ever on the Planner, so the dashboard showed numbers with no
 * indication of their age — and a stockout count from a run three days ago
 * looks exactly like one from this morning. The reference says it here for the
 * same reason, in the same words.
 *
 * Reads the newest prediction directly rather than through the buy list: this
 * renders in the page header, above and independent of the board below, and
 * building the whole plan to date-stamp it would double the dashboard's work.
 */
export async function BuyListFreshness({ tenantId }: { tenantId: string }) {
  const latest = await prismaForTenant(tenantId).prediction.findFirst({
    orderBy: { runDate: "desc" },
    select: { runDate: true },
  });

  if (!latest) {
    // Nothing has run yet. The setup card above already says why and what to do
    // about it, so a second, vaguer version here would only add noise.
    return null;
  }

  const { tone, relative } = planFreshnessLabel(latest.runDate);
  return (
    <p className="text-2xs text-ink-muted">
      Buy list updated <span className="font-mono tabular-nums">{relative}</span>
      {tone === "warning" ? (
        <span className="text-warning"> · it has not refreshed on schedule</span>
      ) : (
        <span> · refreshes automatically after each sync</span>
      )}
    </p>
  );
}
