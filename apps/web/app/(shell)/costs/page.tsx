import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { CostValue } from "@/components/ui/cost-value";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import { getCostCoverage, getCostMovedAlerts, type CostCoverage } from "@/lib/data/costs";
import type { CostSource } from "@/lib/cost";
import { CostImport } from "./cost-import";
import { CostMovedList } from "./cost-moved-list";

export const metadata: Metadata = { title: "Costs" };

const SOURCE_LABEL: Record<CostSource, string> = {
  manual: "Typed",
  qb: "QuickBooks",
  shopify: "Shopify",
  missing: "Missing",
};

function SourceSplit({ split }: { split: CostCoverage["sourceSplit"] }) {
  const order: CostSource[] = ["manual", "qb", "shopify", "missing"];
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {order.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 py-1">
          <span className="text-ink-muted">{SOURCE_LABEL[k]}</span>
          <span className="font-mono font-medium text-ink">{split[k]}</span>
        </span>
      ))}
    </div>
  );
}

async function CostsBoard({
  tenantId,
  canViewCosts,
  canManage,
}: {
  tenantId: string;
  canViewCosts: boolean;
  canManage: boolean;
}) {
  const [coverage, alerts] = await Promise.all([
    getCostCoverage(tenantId, { canViewCosts }),
    getCostMovedAlerts(tenantId, { canViewCosts }),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="Trusted cost"
          value={`${coverage.trustedProductPct}%`}
          delta={{ label: `of ${coverage.products} active products`, tone: "neutral" }}
        />
        <StatTile
          label="Revenue covered"
          value={coverage.trustedRevenuePct == null ? <CostValue amount={null} /> : `${coverage.trustedRevenuePct}%`}
          delta={{ label: "of trailing-30d revenue", tone: "neutral" }}
        />
        <StatTile
          label="Missing / suspect"
          value={`${coverage.products - coverage.trustedProducts}`}
          delta={{ label: "products held off the buy list", tone: coverage.products - coverage.trustedProducts > 0 ? "negative" : "neutral" }}
        />
      </div>

      <Card>
        <CardHeader title="Cost sources" subtitle="Where each product's cost comes from" />
        <CardContent>
          <SourceSplit split={coverage.sourceSplit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Cost moved sharply"
          subtitle="A synced cost that jumped more than ~20% — check the selling price"
        />
        <CostMovedList alerts={alerts} canManage={canManage} />
      </Card>

      <Card>
        <CardHeader title="QuickBooks" subtitle="Optional — sync costs and vendors automatically" />
        <CardContent>
          <p className="text-sm text-ink-muted">
            Not connected. QuickBooks cost sync is not available yet; upload or paste your costs below in the meantime.
          </p>
        </CardContent>
      </Card>

      <CostImport canManage={canManage} />
    </div>
  );
}

export default async function CostsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Costs" description="Cost coverage, upload and QuickBooks" />
        <EmptyState title="No workspace yet" description="Ask an admin to invite you to a workspace." />
      </div>
    );
  }

  const canViewCosts = hasPermission(membership, "view_costs");
  const canManage = hasPermission(membership, "manage_settings");

  return (
    <div className="space-y-6">
      <PageHeader title="Costs" description="Cost coverage, upload/paste and cost-moved alerts" />
      <Suspense
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={6} />
          </Card>
        }
      >
        <CostsBoard tenantId={membership.tenantId} canViewCosts={canViewCosts} canManage={canManage} />
      </Suspense>
    </div>
  );
}
