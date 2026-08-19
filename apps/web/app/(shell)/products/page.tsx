import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { catalogueQueryToSearch, parseCatalogueQuery, type RawSearchParams } from "@/lib/catalogue";
import { CatalogueTable } from "./catalogue-table";

export const metadata: Metadata = {
  title: "Products",
};

/**
 * The catalogue: every product the shop still sells, and the data quality behind
 * the numbers that drive its buying.
 *
 * Was one half of a combined Stock screen with a tab bar. The two halves answer
 * different questions — "what do we sell and is its data sound" against "where
 * is the stock right now" — and they sit in different sections of the rail
 * because a reader looking for one is not browsing for the other.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const params = await searchParams;
  // Scope, filters, sort and page all live in the URL: the server decides which
  // rows to send, so it has to read what the reader chose.
  const query = parseCatalogueQuery(params);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Catalogue" title="Products" description="Every product you sell" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to see its products."
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
        eyebrow="Catalogue"
        title="Products"
        description="Every product you sell, and whether its numbers can be trusted"
      />
      <Suspense
        // Keyed on the whole query: the boundary has to remount for the new
        // query's rows to render, and it shows the skeleton while they load.
        key={catalogueQueryToSearch(query)}
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={10} />
          </Card>
        }
      >
        <CatalogueTable
          tenantId={tenantId}
          canViewCosts={canViewCosts}
          canManage={canManage}
          query={query}
        />
      </Suspense>
    </div>
  );
}
