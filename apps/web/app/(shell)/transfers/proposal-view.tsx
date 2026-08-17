
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDistributionProposal, type RateBasis } from "@/lib/data/transfers";
import { SavePlanBar } from "./save-plan-bar";
import { TransfersExportBar } from "./transfers-export";

/**
 * The live proposal: what to move out of the chosen source today, and why. The
 * "why" is the run-rate column — every line says what that branch sells per day,
 * where its cover stands, and where the move lands it.
 */

/** Per-branch run rate is measured only where sales carry a location. Anything
 *  else is an allocation of the shop-wide rate, and the header says which — a
 *  plan built on an approximation must never read as if it were measured. */
type HeaderBasis = RateBasis | "mixed";

const basisLabel: Record<HeaderBasis, string> = {
  attributed: "Branch sales",
  allocated: "Split by stock",
  even: "Split evenly",
  mixed: "Part measured",
};

const basisCaption: Record<HeaderBasis, string> = {
  attributed: "sized from each branch's own sales",
  allocated: "no per-branch sales yet — the shop-wide rate is split by the stock each branch holds",
  even: "nobody holds it and no branch sales are attributed — split evenly to refill",
  mixed: "some products are sized from branch sales, the rest from the stock each branch holds",
};

export async function ProposalView({
  tenantId,
  fromLocationId,
  coverDays,
  canViewCosts,
  canPlan,
}: {
  tenantId: string;
  fromLocationId: string;
  coverDays: number;
  canViewCosts: boolean;
  canPlan: boolean;
}) {
  // canViewCosts flows into the query, so the value figures come back null for a
  // money-blind member and never reach the payload the client bar serializes.
  const proposal = await getDistributionProposal(tenantId, {
    fromLocationId,
    coverDays,
    canViewCosts,
  });

  if (!proposal) {
    return (
      <EmptyState
        title="Nowhere to send stock"
        description="This location has no selling branch to distribute to. Confirm your location roles in Settings — a warehouse holds stock, a branch sells it."
      />
    );
  }

  if (proposal.lines.length === 0) {
    return (
      <EmptyState
        title="Nothing to move"
        description={`Every branch already has ${proposal.coverDays} days of cover on what ${proposal.fromLocationName} holds, or the branches that are short sell nothing yet.`}
      />
    );
  }

  const bases = new Set(proposal.lines.map((l) => l.rateBasis));
  const basis: HeaderBasis = bases.size === 1 ? [...bases][0]! : "mixed";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Units to move"
          value={formatNumber(proposal.totalUnits)}
          delta={{ label: `out of ${proposal.fromLocationName}`, tone: "neutral" }}
        />
        <StatTile
          label="Products"
          value={formatNumber(proposal.skuCount)}
          delta={{ label: `${proposal.lines.length} lines to pick`, tone: "neutral" }}
        />
        <StatTile
          label="Destinations"
          value={formatNumber(proposal.destinations.length)}
          delta={{ label: `levelled to ${proposal.coverDays} days of cover`, tone: "neutral" }}
        />
        <StatTile
          label="Value on the move"
          value={<CostValue amount={proposal.totalValueKes} canViewCosts={canViewCosts} compact />}
          delta={{ label: "at unit cost", tone: "neutral" }}
        />
      </div>

      <Card>
        <CardHeader
          title={`Send to ${proposal.destinations.length === 1 ? proposal.destinations[0]!.name : `${proposal.destinations.length} branches`}`}
          subtitle={`Sized to give every branch ${proposal.coverDays} days of cover at its own rate — ${basisCaption[basis]}.`}
          action={<Badge tone={proposal.hasAttributedDemand ? "positive" : "neutral"}>{basisLabel[basis]}</Badge>}
        />
        <div className="px-5 pt-4">
          <div className="flex flex-wrap gap-2">
            {proposal.destinations.map((d) => (
              <span
                key={d.locationId}
                className="rounded-md border border-edge bg-surface-2 px-3 py-1.5 text-sm text-ink-secondary"
              >
                <span className="font-medium text-ink">{d.name}</span> · {formatNumber(d.units)} units ·{" "}
                {d.skus} SKUs · <CostValue amount={d.valueKes} canViewCosts={canViewCosts} compact />
              </span>
            ))}
          </div>
        </div>

        {proposal.skipped.length > 0 && (
          <p className="px-5 pt-4 text-sm text-ink-muted">
            No stock sized for {proposal.skipped.map((s) => s.name).join(", ")} — nothing sold there
            and nothing on the shelf, so there is no rate to plan against. Send opening stock by hand.
          </p>
        )}

        <div className="mt-2 pb-2">
          <Table>
            <TableHeader>
              <TableHead>Product</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>To</TableHead>
              <TableHead numeric>Move</TableHead>
              <TableHead numeric>Sells/day</TableHead>
              <TableHead numeric>Cover</TableHead>
              <TableHead numeric>Value</TableHead>
            </TableHeader>
            <TableBody>
              {proposal.lines.map((line) => (
                <TableRow key={`${line.productId}:${line.toLocationId}`}>
                  <TableCell className="font-medium text-ink">{line.title}</TableCell>
                  <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                  <TableCell>{line.toLocationName}</TableCell>
                  <TableCell numeric>{formatNumber(line.qty)}</TableCell>
                  <TableCell numeric>{line.toRunRate.toFixed(2)}</TableCell>
                  <TableCell numeric>
                    <span className="text-ink-muted">{line.toDaysCoverBefore}d</span>
                    <span className="px-1 text-ink-muted">→</span>
                    <span>{line.toDaysCoverAfter}d</span>
                  </TableCell>
                  <TableCell numeric>
                    <CostValue amount={line.valueKes} canViewCosts={canViewCosts} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-5 py-4">
          <TransfersExportBar
            rows={proposal.lines}
            canViewCosts={canViewCosts}
            fromLocationName={proposal.fromLocationName}
            coverDays={proposal.coverDays}
          />
          <SavePlanBar
            fromLocationId={proposal.fromLocationId}
            fromLocationName={proposal.fromLocationName}
            coverDays={proposal.coverDays}
            canPlan={canPlan}
          />
        </div>
      </Card>
    </div>
  );
}
