import type { Metadata } from "next";
import { Suspense } from "react";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard } from "@/components/ui/skeleton";
import { getActivity } from "@/lib/data/activity";

export const metadata: Metadata = {
  title: "Activity log",
};

const when = (at: Date) =>
  at.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

async function ActivityList({
  tenantId,
  canViewCosts,
  currency,
}: {
  tenantId: string;
  canViewCosts: boolean;
  currency: string;
}) {
  const entries = await getActivity(tenantId, { canViewCosts, currency });

  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nothing recorded yet"
          description="Once orders are placed, received or cancelled — or a cost is changed — it shows up here."
        />
      </Card>
    );
  }

  return (
    <Card>
      <ul>
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-col gap-1 border-b border-edge px-5 py-3 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          >
            <span className="text-sm text-ink">
              {entry.summary}
              {entry.actor && <span className="text-ink-muted"> · {entry.actor}</span>}
            </span>
            <span className="shrink-0 text-xs text-ink-muted">{when(entry.at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default async function ActivityPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity log"
        description="Who created, ordered, cancelled or received orders, and who changed a cost. Kept for accounting — entries can't be edited or removed."
      />
      {membership && (
        <Suspense fallback={<SkeletonCard />}>
          <ActivityList
            tenantId={membership.tenantId}
            canViewCosts={hasPermission(membership, "view_costs")}
            currency={membership.tenant.currency ?? "KES"}
          />
        </Suspense>
      )}
    </div>
  );
}
