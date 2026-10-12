
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { AbcBadge } from "@/components/ui/abc-badge";
import { formatNumber } from "@/lib/money";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { Pager } from "@/components/ui/pager";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EMPTY_TRANSFER_SCOPE,
  getDistributionProposal,
  PROPOSAL_PAGE_SIZE,
  type RateBasis,
  type TransferScope,
} from "@/lib/data/transfers";
import { SavePlanBar } from "./save-plan-bar";
import { TransfersExportBar } from "./transfers-export";
import { TransferScopeChips } from "./transfer-scope-chips";

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
  windowDays,
  canViewCosts,
  canPlan,
  scope = EMPTY_TRANSFER_SCOPE,
  page = 0,
  queryHref = () => "/transfers",
}: {
  tenantId: string;
  fromLocationId: string;
  coverDays: number;
  windowDays?: number;
  canViewCosts: boolean;
  canPlan: boolean;
  scope?: TransferScope;
  page?: number;
  /** Builds a full /transfers URL for the given overrides, carrying the
   *  screen's other state (source, cover, window) — the same href-builder the
   *  page uses for its own pills. Omitted only by callers with no filter/page
   *  UI of their own (e.g. a test rendering the view directly) — the chips and
   *  pager still need SOME href, even if that caller never follows it. */
  queryHref?: (next: { abc?: string[]; category?: string[]; page?: number }) => string;
}) {
  // canViewCosts flows into the query, so the value figures come back null for a
  // money-blind member and never reach the payload the client bar serializes.
  const proposal = await getDistributionProposal(tenantId, {
    fromLocationId,
    coverDays,
    windowDays,
    canViewCosts,
    scope,
    page,
  });

  if (!proposal) {
    return (
      <EmptyState
        title="Nowhere to send stock"
        description="This location has no selling branch to distribute to. Confirm your location roles in Settings — a warehouse holds stock, a branch sells it."
      />
    );
  }

  const scopeChips = (
    <TransferScopeChips
      facets={proposal.scopeFacets}
      selection={scope}
      hrefFor={(next) => queryHref({ ...next, page: 0 })}
    />
  );

  if (proposal.matchedCount === 0) {
    return (
      <div className="space-y-4">
        {scopeChips}
        <EmptyState
          title="Nothing to move"
          description={
            scope.abc.length > 0 || scope.category.length > 0
              ? "No products in this filter need moving right now. Clear a filter to see the full proposal."
              : `Every branch already has ${proposal.coverDays} days of cover on what ${proposal.fromLocationName} holds, or the branches that are short sell nothing yet.`
          }
        />
      </div>
    );
  }

  // The basis badge describes the WHOLE plan's honesty, not just the page on
  // screen — a plan that is "mixed" overall must not read as purely
  // "measured" just because page 2 happens to be all-attributed lines.
  const bases = new Set(proposal.allMatchedLines.map((l) => l.rateBasis));
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
          delta={{ label: `${proposal.matchedCount} lines to pick`, tone: "neutral" }}
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

      {scopeChips}

      <Card>
        <CardHeader
          title={`Send to ${proposal.destinations.length === 1 ? proposal.destinations[0]!.name : `${proposal.destinations.length} branches`}`}
          subtitle={`Sized to give every branch ${proposal.coverDays} days of cover at its own rate — ${basisCaption[basis]}.`}
          action={<Badge tone={proposal.hasAttributedDemand ? "positive" : "neutral"}>{basisLabel[basis]}</Badge>}
        />
        {/* Where these lines are going, as a band across the top of the rows
            rather than a chip floating above them — the reference leads every
            grouped table this way, and it carries the same four facts. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-y border-edge bg-surface-2 px-5 py-2 text-2xs tracking-wider text-ink-muted uppercase">
          {proposal.destinations.map((d) => (
            <span key={d.locationId}>
              <span className="font-semibold text-ink-secondary">{d.name}</span> ·{" "}
              {formatNumber(d.units)} units · {d.skus} SKUs ·{" "}
              <CostValue amount={d.valueKes} canViewCosts={canViewCosts} compact />
            </span>
          ))}
        </div>

        {proposal.skipped.length > 0 && (
          <p className="px-5 pt-4 text-sm text-ink-muted">
            No stock sized for {proposal.skipped.map((s) => s.name).join(", ")} — nothing sold there
            and nothing on the shelf, so there is no rate to plan against. Send opening stock by hand.
          </p>
        )}

        <div className="pb-2">
          <Table dense boxed>
            <TableHeader>
              <TableHead>Product</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>To</TableHead>
              <TableHead numeric>Sells/day</TableHead>
              <TableHead numeric>Cover</TableHead>
              <TableHead numeric>Value</TableHead>
              <TableHead>Class</TableHead>
              <TableHead numeric>Source stock</TableHead>
              <TableHead numeric>Branch stock</TableHead>
              <TableHead numeric>Move</TableHead>
            </TableHeader>
            <TableBody>
              {proposal.lines.map((line) => (
                <TableRow key={`${line.productId}:${line.toLocationId}`}>
                  <TableCell className="max-w-80 font-medium whitespace-normal wrap-break-word text-ink">
                    {line.title}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                  <TableCell>{line.toLocationName}</TableCell>
                  <TableCell numeric>{line.toRunRate.toFixed(2)}</TableCell>
                  <TableCell numeric>
                    <span className="text-ink-muted">{line.toDaysCoverBefore}d</span>
                    <span className="px-1 text-ink-muted">→</span>
                    <span>{line.toDaysCoverAfter}d</span>
                  </TableCell>
                  <TableCell numeric>
                    <CostValue amount={line.valueKes} canViewCosts={canViewCosts} />
                  </TableCell>
                  <TableCell>
                    <AbcBadge value={line.abc} />
                  </TableCell>
                  <TableCell numeric>{formatNumber(line.fromOnHand)}</TableCell>
                  <TableCell numeric>{formatNumber(line.toOnHand)}</TableCell>
                  <TableCell numeric>{formatNumber(line.qty)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {proposal.pageCount > 1 && (
            <Pager
              page={proposal.page}
              pageCount={proposal.pageCount}
              from={proposal.page * PROPOSAL_PAGE_SIZE + 1}
              to={proposal.page * PROPOSAL_PAGE_SIZE + proposal.lines.length}
              total={proposal.matchedCount}
              pageHref={(next) => queryHref({ page: next })}
              label="Transfer proposal pages"
              unit="lines"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-5 py-4">
          <TransfersExportBar
            rows={proposal.allMatchedLines}
            canViewCosts={canViewCosts}
            fromLocationName={proposal.fromLocationName}
            coverDays={proposal.coverDays}
          />
          <SavePlanBar
            fromLocationId={proposal.fromLocationId}
            fromLocationName={proposal.fromLocationName}
            coverDays={proposal.coverDays}
            canPlan={canPlan}
            windowDays={proposal.windowDays}
          />
        </div>
      </Card>
    </div>
  );
}
