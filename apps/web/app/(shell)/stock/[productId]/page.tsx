import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard } from "@/components/ui/skeleton";
import { getProductDetail } from "@/lib/data/product-detail";
import { ProductDetailView } from "./product-detail-view";

export const metadata: Metadata = {
  title: "Product",
};

async function ProductContent({
  tenantId,
  productId,
  canViewCosts,
}: {
  tenantId: string;
  productId: string;
  canViewCosts: boolean;
}) {
  // canViewCosts flows into the query: a money-blind member's payload comes back
  // with null costs, so the numbers never reach the browser at all.
  const detail = await getProductDetail(tenantId, productId, { canViewCosts });
  // A product from another workspace resolves to nothing on the tenant client,
  // so this is a 404 rather than a "not allowed" — the id isn't confirmed to exist.
  if (!detail) notFound();
  return <ProductDetailView detail={detail} canViewCosts={canViewCosts} />;
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Product" description="One product and everything about it" />
        <EmptyState
          title="No workspace yet"
          description="Ask an admin to invite you to a workspace to see its products."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Stock", href: "/stock" }, { label: "Product" }]}
        title="Product"
        description="One product and everything about it"
      />
      <Suspense fallback={<SkeletonCard lines={8} />}>
        <ProductContent
          tenantId={membership.tenantId}
          productId={productId}
          canViewCosts={hasPermission(membership, "view_costs")}
        />
      </Suspense>
    </div>
  );
}
