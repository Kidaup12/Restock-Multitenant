import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getSupplierProductPicker } from "@/lib/data/suppliers";
import { ProductPicker } from "./product-picker";

export const metadata: Metadata = { title: "Supplier products" };

/**
 * "Which products do I buy from this supplier?" — the way round a shop actually
 * thinks about it.
 *
 * Until now a product got a supplier only by assigning a whole Shopify brand at
 * once, and only if it had none yet; there was nowhere in the app to attach a
 * single product or move one that had ended up in the wrong place.
 *
 * A page rather than a dialog because the list is searchable and worth a URL:
 * search runs as a plain GET, so the server does the filtering and a reload
 * keeps the shop where it was.
 */
export default async function SupplierProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) notFound();

  const { id } = await params;
  const { q } = await searchParams;
  const canManage = hasPermission(membership, "manage_settings");

  const picker = await getSupplierProductPicker(membership.tenantId, id, q);
  if (!picker) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: "Suppliers", href: "/suppliers" },
          { label: picker.supplierName },
        ]}
        title={picker.supplierName}
        description="Tick everything you buy from them. A product can only sit with one supplier, so ticking moves it."
      />
      {canManage ? (
        <ProductPicker
          supplierId={picker.supplierId}
          supplierName={picker.supplierName}
          products={picker.products}
          truncated={picker.truncated}
          search={q ?? ""}
        />
      ) : (
        <EmptyState
          title="You can look, not change"
          description="Assigning products to a supplier needs settings access in this workspace."
        />
      )}
    </div>
  );
}
