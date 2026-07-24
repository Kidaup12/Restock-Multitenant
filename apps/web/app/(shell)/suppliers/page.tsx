import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTableRows } from "@/components/ui/skeleton";
import {
  getSupplierOptions,
  getSuppliers,
  getUnassignedByBrand,
} from "@/lib/data/suppliers";
import { SuppliersView } from "./suppliers-view";

export const metadata: Metadata = {
  title: "Suppliers",
};

export default async function SuppliersPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

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
        fallback={
          <Card className="p-5">
            <SkeletonTableRows rows={6} />
          </Card>
        }
      >
        <SuppliersData tenantId={tenantId} canManage={canManage} />
      </Suspense>
    </div>
  );
}

async function SuppliersData({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const [rows, unassignedBrands, supplierOptions] = await Promise.all([
    getSuppliers(tenantId),
    getUnassignedByBrand(tenantId),
    getSupplierOptions(tenantId),
  ]);
  return (
    <SuppliersView
      rows={rows}
      unassignedBrands={unassignedBrands}
      supplierOptions={supplierOptions}
      canManage={canManage}
    />
  );
}
