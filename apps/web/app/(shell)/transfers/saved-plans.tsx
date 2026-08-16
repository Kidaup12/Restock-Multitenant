import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { Pager } from "@/components/ui/pager";
import { TableSearch } from "@/components/ui/table-search";
import { formatNumber } from "@/lib/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listDistributionPlansScreen,
  savedPlansSearch,
  type SavedPlansQuery,
} from "@/lib/data/transfers";
import { PlanRowActions } from "./plan-row-actions";

/**
 * Plans already saved. A draft can still be finalised or dropped; a finalised
 * plan is the record of a decision and stays as it was picked.
 *
 * A shop that plans weekly has a year of these inside twelve months, so the
 * list pages rather than stopping silently, and the search box finds the one
 * plan someone is asking about by its name or the branch it came out of.
 */

const statusTone = { draft: "neutral", final: "accent", exported: "positive" } as const;
const statusLabel: Record<string, string> = {
  draft: "Draft",
  final: "Final",
  exported: "Exported",
};

export async function SavedPlans({
  tenantId,
  canViewCosts,
  canPlan,
  carry,
  query,
}: {
  tenantId: string;
  canViewCosts: boolean;
  canPlan: boolean;
  /** The rest of the transfers query — the source branch and cover target the
   *  proposal above is built from, which a search or a page turn must keep. */
  carry: { name: string; value: string }[];
  query: SavedPlansQuery;
}) {
  const screen = await listDistributionPlansScreen(tenantId, { canViewCosts, query });
  if (screen.total === 0) return null;

  const hrefFor = (next: Partial<SavedPlansQuery>) =>
    `/transfers${savedPlansSearch(carry, { ...query, ...next })}`;

  return (
    <Card>
      <CardHeader
        title="Saved plans"
        subtitle="What you decided to move, and when."
      />
      {/* The form posts `q` itself and carries no page, so a new search always
          lands on the first page of its own results. */}
      <TableSearch
        action="/transfers"
        value={query.search}
        hidden={carry}
        placeholder="Search plans by name or branch…"
        matched={query.search ? screen.matched : null}
        clearHref={hrefFor({ search: "", page: 0 })}
        label="Search saved plans"
      />
      <div className="mt-2 pb-2">
        <Table>
          <TableHeader>
            <TableHead>Plan</TableHead>
            <TableHead>From</TableHead>
            <TableHead numeric>Units</TableHead>
            <TableHead numeric>Lines</TableHead>
            <TableHead numeric>Value</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>{canPlan ? "Actions" : ""}</TableHead>
          </TableHeader>
          <TableBody>
            {screen.plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell className="font-medium text-ink">
                  {plan.name ?? "Untitled plan"}
                  <span className="block text-xs font-normal text-ink-muted">
                    {plan.coverDays}d cover · {plan.createdAt.toISOString().slice(0, 10)}
                  </span>
                </TableCell>
                <TableCell>{plan.fromLocationName}</TableCell>
                <TableCell numeric>{formatNumber(plan.units)}</TableCell>
                <TableCell numeric>{formatNumber(plan.lineCount)}</TableCell>
                <TableCell numeric>
                  <CostValue amount={plan.valueKes} canViewCosts={canViewCosts} compact />
                </TableCell>
                <TableCell>
                  <Badge tone={statusTone[plan.status as keyof typeof statusTone] ?? "neutral"}>
                    {statusLabel[plan.status] ?? plan.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {canPlan && <PlanRowActions planId={plan.id} status={plan.status} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {screen.matched === 0 && (
          <p className="px-4 py-6 text-sm text-ink-muted">
            No saved plan matches that. Clear the search to see all {screen.total}.
          </p>
        )}
      </div>
      {screen.pageCount > 1 && (
        <Pager
          page={screen.page}
          pageCount={screen.pageCount}
          from={screen.from}
          to={screen.from + screen.plans.length - 1}
          total={screen.matched}
          pageHref={(next) => hrefFor({ page: next })}
          label="Saved plan pages"
        />
      )}
    </Card>
  );
}
