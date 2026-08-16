import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import {
  getAssignableProducts,
  getSupplierOptions,
  getSuppliers,
  getSuppliersScreen,
  getUnassignedByBrand,
  parseSupplierQuery,
  selectSuppliers,
  type SupplierQuery,
  type SupplierRow,
} from "@/lib/data/suppliers";
import { SuppliersView } from "./suppliers-view";

export const metadata: Metadata = {
  title: "Suppliers",
};

/**
 * The full list behind the export button. The table holds one page, so the file
 * has to be fetched rather than read off the screen — and like every server
 * entry point it resolves the reader itself rather than trusting the caller.
 */
async function exportSuppliers(query: SupplierQuery): Promise<SupplierRow[]> {
  "use server";
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return [];
  return selectSuppliers(await getSuppliers(membership.tenantId), query);
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const query = parseSupplierQuery(await searchParams);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Suppliers" description="Lead times, deliveries, and who supplies what" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to manage its suppliers."
        />
      </div>
    );
  }

  const tenantId = membership.tenantId;
  const canManage = hasPermission(membership, "manage_settings");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description="Lead times, learned deliveries, and who supplies what"
      />
      <Suspense
        key={supplierQueryKey(query)}
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={6} />
          </Card>
        }
      >
        <SuppliersData tenantId={tenantId} canManage={canManage} query={query} />
      </Suspense>
    </div>
  );
}

/** A new search, sort or page re-suspends the table rather than leaving the old
 *  rows on screen while the new ones load. */
function supplierQueryKey(query: SupplierQuery): string {
  return `${query.search}:${query.sortKey}:${query.desc}:${query.page}`;
}

async function SuppliersData({
  tenantId,
  canManage,
  query,
}: {
  tenantId: string;
  canManage: boolean;
  query: SupplierQuery;
}) {
  const [screen, unassignedBrands, supplierOptions, assignableProducts] = await Promise.all([
    getSuppliersScreen(tenantId, query),
    getUnassignedByBrand(tenantId),
    getSupplierOptions(tenantId),
    getAssignableProducts(tenantId),
  ]);
  return (
    <SuppliersView
      rows={screen.rows}
      paging={{
        total: screen.total,
        matched: screen.matched,
        page: screen.page,
        pageCount: screen.pageCount,
        from: screen.from,
        query,
        exportRows: exportSuppliers.bind(null, query),
      }}
      unassignedBrands={unassignedBrands}
      supplierOptions={supplierOptions}
      assignableProducts={assignableProducts}
      canManage={canManage}
    />
  );
}
