import { notFound } from "next/navigation";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getTenantFeatureOverrides, getTenantPlan, planAllows } from "@/lib/capabilities";
import { getDistributionPlan } from "@/lib/data/transfers";
import { EmptyState } from "@/components/ui/empty-state";
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
  const plan = await getDistributionPlan(membership.tenantId, id, { canViewCosts });
  if (!plan) notFound();
  return <SavedPlanView plan={plan} canViewCosts={canViewCosts} canPlan={hasPermission(membership, "approve_orders")} />;
}
