import { notFound } from "next/navigation";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getTenantFeatureOverrides, getTenantPlan, planAllows } from "@/lib/capabilities";
import { getDistributionPlan } from "@/lib/data/transfers";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PlanRowActions } from "../plan-row-actions";
import { SavedPlanView } from "../saved-plan-view";

export default async function TransferPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) notFound();
  const [tier, overrides] = await Promise.all([
    getTenantPlan(membership.tenantId), getTenantFeatureOverrides(membership.tenantId),
  ]);
  if (!planAllows(tier, "transfers", overrides)) {
    return <EmptyState title="Transfers are not enabled" description="Ask your workspace owner about enabling transfers." />;
  }
  const { id } = await params;
  const canViewCosts = hasPermission(membership, "view_costs");
  const canPlan = hasPermission(membership, "approve_orders");
  const plan = await getDistributionPlan(membership.tenantId, id, { canViewCosts });
  if (!plan) notFound();
  return (
    <div className="space-y-6">
      {/* The header lives on the route (like every other nested page), so the
          breadcrumb trail back to the list is here rather than in the body. */}
      <PageHeader
        title={plan.name ?? "Transfer plan"}
        breadcrumbs={[{ label: "Transfers", href: "/transfers" }, { label: "Saved plan" }]}
        description={`${plan.status} · From ${plan.fromLocationName} · ${plan.units} units · ${plan.coverDays}d cover · ${plan.windowDays}d branch sales window`}
        actions={canPlan ? <PlanRowActions planId={plan.id} status={plan.status} /> : undefined}
      />
      <SavedPlanView plan={plan} canViewCosts={canViewCosts} canPlan={canPlan} />
    </div>
  );
}
