import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getRecommendations } from "@/lib/data/recommendations";
import { RecommendationsView } from "./recommendations-view";

export const metadata: Metadata = { title: "Recommendations" };

export default async function RecommendationsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const header = (
    <PageHeader
      eyebrow="Stock"
      title="Recommendations"
      description="Stock that isn't selling, and what to do about it — discounts, bundles, reorders to skip. Updated every morning."
    />
  );
  if (!membership) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title="No workspace yet" description="Ask an admin to invite you to a workspace." />
      </div>
    );
  }

  const canViewCosts = hasPermission(membership, "view_costs");
  const list = await getRecommendations(membership.tenantId, { canViewCosts });

  return (
    <div className="space-y-6">
      {header}
      {list.rows.length === 0 ? (
        <EmptyState
          title={list.lastRunAt ? "Nothing to act on" : "No recommendations yet"}
          description={
            list.lastRunAt
              ? "Everything on the shelf is selling at a healthy pace. New suggestions appear here each morning."
              : "Recommendations are worked out each morning from your sales and stock. Check back tomorrow."
          }
        />
      ) : (
        <RecommendationsView
          list={list}
          canViewCosts={canViewCosts}
          canOrder={hasPermission(membership, "approve_orders")}
          canPlanOffers={hasPermission(membership, "manage_settings")}
        />
      )}
    </div>
  );
}
