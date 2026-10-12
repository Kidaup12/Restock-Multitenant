import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RefreshButton } from "./refresh-button";
import { GuideBox } from "@/components/ui/guide-box";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { locationsQueryToSearch, parseLocationsQuery } from "@/lib/data/stock";
import type { RawSearchParams } from "@/lib/catalogue";
import { LocationView } from "./location-view";

export const metadata: Metadata = {
  title: "Inventory",
};

/**
 * Where the stock actually is, branch by branch.
 *
 * The other half of what used to be a tabbed Stock screen. This one answers
 * "where is it and how long will it last there"; the catalogue answers "what do
 * we sell". Splitting them also split their querystrings — locations carries a
 * search and a page and nothing else, and no longer borrows the catalogue's
 * serializer to say so.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const params = await searchParams;
  const query = parseLocationsQuery(params);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Stock" title="Inventory" description="Where your stock is" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to see its inventory."
        />
      </div>
    );
  }

  const tenantId = membership.tenantId;
  const canViewCosts = hasPermission(membership, "view_costs");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Stock"
        title="Inventory"
        // Says that the headings sort. The explainer says it too, but that is
        // dismissed for anyone past their first week — and a column you do not
        // know is clickable is a column that never gets clicked.
        description="Where your stock sits, branch by branch. Click any column heading to sort by it."
        actions={<><Link href="/inventory/position" className="rounded border border-line px-3 py-2 text-sm">Inventory position</Link><RefreshButton /></>}
      />

      <p className="text-sm text-ink-muted">
        Check shelf quantities with a{" "}
        <Link href="/spot-check" className="font-medium text-accent-ink hover:underline">
          weekly count
        </Link>.
      </p>

      <GuideBox id="inventory" scope={membership.tenantId} title="Where your stock actually sits">
        One line per product per branch. Units and value are that
        branch&rsquo;s own. Cover and en-route stock are the whole shop&rsquo;s. Branch cover is unavailable because sales are
        not yet attributed to the branch that made them &mdash; the column and the
        export both say &ldquo;shop&rdquo; for that reason. Click any column heading to sort
        by it.
      </GuideBox>
      <Suspense
        key={locationsQueryToSearch(query)}
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={10} />
          </Card>
        }
      >
        <LocationView tenantId={tenantId} canViewCosts={canViewCosts} params={params} />
      </Suspense>
    </div>
  );
}
