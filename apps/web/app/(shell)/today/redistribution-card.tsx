import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { getDistributionProposal } from "@/lib/data/transfers";

/**
 * "Move stock, don't buy it" — the nudge that puts the transfers plan in front of
 * the owner before they open the buy list. When a warehouse (or a branch) holds
 * stock that a short branch could be selling, the answer to "we're low" is a move,
 * not a purchase.
 *
 * It reuses `getDistributionProposal` — the same engine the /transfers screen
 * renders — and reads only its totals, so no new Prisma and no new cost surface.
 * The proposal already returns null when there is no source or nowhere sellable
 * to send to (a single-shop tenant), and an empty `lines` array when every branch
 * is already covered; both cases render nothing here, so the card only appears
 * when there is a worthwhile move to make.
 *
 * Value in transit is gated by canViewCosts exactly as the transfers table is —
 * the getter nulls `totalValueKes` for a money-blind member, and CostValue masks
 * whatever reaches it.
 */
export async function RedistributionCard({
  tenantId,
  canViewCosts,
}: {
  tenantId: string;
  canViewCosts: boolean;
  /** The workspace currency. Kept for a stable call signature; the money figure
   *  reads the currency from context via CostValue, so it isn't threaded here. */
  currency: string;
}) {
  const proposal = await getDistributionProposal(tenantId, { canViewCosts });

  // No source / nowhere sellable to send to (a single-location shop) → null.
  // Nothing worth moving (every branch already covered) → null. Either way the
  // owner sees no card rather than an empty prompt.
  if (!proposal || proposal.lines.length === 0) return null;

  const { skuCount, totalUnits, totalValueKes, lines, fromLocationName } = proposal;
  // A compact nudge, not the full table — the top few moves only.
  const preview = lines.slice(0, 3);

  return (
    <Card className="border-accent/40 bg-accent-soft/40">
      <CardHeader
        title="Move stock, don't buy it"
        subtitle={`${formatNumber(skuCount)} ${
          skuCount === 1 ? "product" : "products"
        } can be rebalanced across your branches to fix cover without spending.`}
        action={
          <Badge tone="accent">
            {formatNumber(totalUnits)} {totalUnits === 1 ? "unit" : "units"}
          </Badge>
        }
      />
      <CardContent className="pt-4">
        <ul className="space-y-1.5 text-sm">
          {preview.map((line) => (
            <li
              key={`${line.productId}:${line.toLocationId}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
            >
              <span className="font-medium text-ink">{line.title}</span>
              <span className="text-ink-muted">
                {fromLocationName} <span className="px-0.5">→</span> {line.toLocationName}
              </span>
              <span className="ml-auto tabular-nums text-ink-secondary">
                {formatNumber(line.qty)} {line.qty === 1 ? "unit" : "units"}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <span className="text-ink-muted">
            Value in transit{" "}
            <CostValue
              amount={totalValueKes}
              canViewCosts={canViewCosts}
              compact
              className="font-medium text-ink-secondary"
            />
          </span>
          <Link
            href="/transfers"
            className="font-medium text-accent-ink underline-offset-2 hover:underline"
          >
            Plan transfers →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
