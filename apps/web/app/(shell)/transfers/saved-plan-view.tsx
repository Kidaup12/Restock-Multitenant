import type { SavedPlan } from "@/lib/data/transfers";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { PlanRowActions } from "./plan-row-actions";
import { TransfersExportBar } from "./transfers-export";
import { LineQuantityEditor } from "./line-quantity-editor";

export function SavedPlanView({ plan, canViewCosts, canPlan }: { plan: SavedPlan; canViewCosts: boolean; canPlan: boolean }) {
  const destinations = [...new Set(plan.lines.map(line => line.toLocationId))];
  return <div className="space-y-6">
    <PageHeader title={plan.name ?? "Transfer plan"} breadcrumbs={[{ label: "Transfers", href: "/transfers" }, { label: "Saved plan" }]}
      description={`${plan.status} · From ${plan.fromLocationName} · ${plan.units} units · ${plan.coverDays}d cover · ${plan.windowDays}d branch sales window`}
      actions={canPlan ? <PlanRowActions planId={plan.id} status={plan.status} /> : undefined} />
    <p className="text-sm text-ink-muted">Quantities and stock positions were saved with this plan. Confirm current stock before picking. Finalising records the plan; it does not move stock in Shopify. Values use current product costs.</p>
    {canPlan && plan.status === "draft" && <p className="text-sm text-ink-muted">Adjust a move quantity and save it before finalising. Zero means no move. Edits check current source availability across all branches in this plan; separate plans do not reserve stock.</p>}
    <TransfersExportBar rows={plan.lines} canViewCosts={canViewCosts} fromLocationName={plan.fromLocationName} coverDays={plan.coverDays} />
    {destinations.map(id => {
      const lines = plan.lines.filter(line => line.toLocationId === id).sort((a, b) => b.toRunRate - a.toRunRate || b.qty - a.qty);
      return <Card key={id}>
        <CardHeader title={`Send to ${lines[0]!.toLocationName}`} subtitle={`${lines.length} products · ${lines.reduce((sum, line) => sum + line.qty, 0)} units · fastest sellers first`} />
        <div className="mt-4"><Table dense boxed>
          <TableHeader><TableHead>Product</TableHead><TableHead>SKU</TableHead><TableHead numeric>Source stock</TableHead><TableHead numeric>Branch stock</TableHead><TableHead numeric>Move</TableHead><TableHead numeric>Sells/day</TableHead><TableHead numeric>Cover before → after</TableHead>{canViewCosts && <TableHead numeric>Value</TableHead>}</TableHeader>
          <TableBody>{lines.map(line => <TableRow key={line.id}>
            <TableCell className="max-w-80 whitespace-normal wrap-break-word">{line.title}</TableCell><TableCell>{line.sku}</TableCell>
            <TableCell numeric>{line.fromOnHand}</TableCell><TableCell numeric>{line.toOnHand}</TableCell><TableCell numeric>{canPlan && plan.status === "draft" ? <LineQuantityEditor key={`${line.id}:${line.qty}`} planId={plan.id} lineId={line.id} qty={line.qty} title={line.title} /> : line.qty}</TableCell><TableCell numeric>{line.toRunRate.toFixed(2)}</TableCell>
            <TableCell numeric>{line.toDaysCoverBefore == null ? "—" : `${line.toDaysCoverBefore}d`} → {line.toDaysCoverAfter == null ? "—" : `${line.toDaysCoverAfter}d`}</TableCell>
            {canViewCosts && <TableCell numeric><CostValue amount={line.valueKes} canViewCosts={canViewCosts} /></TableCell>}
          </TableRow>)}</TableBody>
        </Table></div>
      </Card>;
    })}
  </div>;
}
