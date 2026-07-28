import Link from "next/link";
import { BoxIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { getCustomCategories, getStockCatalogue } from "@/lib/data/stock";
import { CatalogueView } from "./catalogue-view";
import { getOwnerFlags } from "./owner-flags";

export async function CatalogueTable({
  tenantId,
  canViewCosts = true,
  canManage = false,
}: {
  tenantId: string;
  canViewCosts?: boolean;
  canManage?: boolean;
}) {
  // canViewCosts flows into the query: unit costs and stock values come back
  // null for a money-blind member, so the figures never reach the payload.
  // ownerFlags carries the archive / keep-active switches the row editor drives;
  // they are editor state rather than a catalogue metric, so they ride alongside.
  const [rows, categories, ownerFlags] = await Promise.all([
    getStockCatalogue(tenantId, { canViewCosts }),
    getCustomCategories(tenantId),
    getOwnerFlags(tenantId),
  ]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No products yet"
        description="Your products appear here once your Shopify catalogue has synced."
        action={
          <Link
            href="/settings/connections"
            className="flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
          >
            Connect Shopify
          </Link>
        }
      />
    );
  }


  return (
    <CatalogueView
      rows={rows}
      categories={categories}
      ownerFlags={ownerFlags}
      canViewCosts={canViewCosts}
      canManage={canManage}
    />
  );
}
