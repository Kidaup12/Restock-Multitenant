import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { catalogueQueryToSearch, parseCatalogueQuery, type RawSearchParams } from "@/lib/catalogue";
import { CatalogueTable } from "./catalogue-table";
import { LocationView } from "./location-view";

export const metadata: Metadata = {
  title: "Stock",
};

function ViewTabs({ view }: { view: "products" | "locations" }) {
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-accent-soft text-accent-ink"
          : "text-ink-muted hover:bg-surface-2 hover:text-ink"
      )}
    >
      {label}
    </Link>
  );
  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-edge bg-surface p-1"
      data-tour="stock-tabs"
    >
      {tab("/stock", "By product", view === "products")}
      {tab("/stock?view=locations", "By location", view === "locations")}
    </div>
  );
}

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const params = await searchParams;
  const view = params.view === "locations" ? "locations" : "products";
  // Scope, filters, sort and page all live in the URL: the server decides which
  // rows to send, so it has to read what the reader chose.
  const query = parseCatalogueQuery(params);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Stock" description="Every tracked product and its position" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to see its stock."
        />
      </div>
    );
  }

  const tenantId = membership.tenantId;
  // Money-blind gate: MEMBERs (without view_costs) see no KES cost figures.
  const canViewCosts = hasPermission(membership, "view_costs");
  // Catalogue editing (cost pin, category, not-for-sale) needs settings access.
  const canManage = hasPermission(membership, "manage_settings");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock"
        description="Every tracked product and its position"
        actions={<ViewTabs view={view} />}
      />
      <Suspense
        // Keyed on the whole query, not just the tab: the boundary has to
        // remount for the new query's rows to render, and it shows the skeleton
        // while they load.
        key={`${view}${catalogueQueryToSearch(query)}`}
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={10} />
          </Card>
        }
      >
        {view === "locations" ? (
          <LocationView tenantId={tenantId} canViewCosts={canViewCosts} params={params} />
        ) : (
          <CatalogueTable
            tenantId={tenantId}
            canViewCosts={canViewCosts}
            canManage={canManage}
            query={query}
          />
        )}
      </Suspense>
    </div>
  );
}
