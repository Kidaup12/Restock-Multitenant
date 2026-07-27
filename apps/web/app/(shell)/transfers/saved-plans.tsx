import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue, formatNumber } from "@/components/ui/cost-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listDistributionPlans } from "@/lib/data/transfers";
import { PlanRowActions } from "./plan-row-actions";

/**
 * Plans already saved. A draft can still be finalised or dropped; a finalised
 * plan is the record of a decision and stays as it was picked.
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
}: {
  tenantId: string;
  canViewCosts: boolean;
  canPlan: boolean;
}) {
  const plans = await listDistributionPlans(tenantId, { canViewCosts });
  if (plans.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Saved plans"
        subtitle="What you decided to move, and when."
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
            {plans.map((plan) => (
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
      </div>
    </Card>
  );
}
