import { BoxIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { getCustomCategories, getStockCatalogue } from "@/lib/data/stock";
import { deriveFacetOptions } from "@/lib/facets";
import { CatalogueView } from "./catalogue-view";

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
  const [rows, categories] = await Promise.all([
    getStockCatalogue(tenantId, { canViewCosts }),
    getCustomCategories(tenantId),
  ]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No products yet"
        description="Products appear here once a catalogue sync or import lands."
      />
    );
  }

  // Facet options derived from what the catalogue actually contains (spec §7) —
  // never a hard-coded list. The interactive view filters + sorts client-side.
  const facetOptions = deriveFacetOptions(rows.map((r) => r.facet));

  return (
    <CatalogueView
      rows={rows}
      facetOptions={facetOptions}
      categories={categories}
      canViewCosts={canViewCosts}
      canManage={canManage}
    />
  );
}
