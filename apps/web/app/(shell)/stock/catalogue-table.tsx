import { ButtonLink } from "@/components/ui/button";
import { BoxIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { getCatalogueScreen, getCustomCategories } from "@/lib/data/stock";
import type { CatalogueQuery } from "@/lib/catalogue";
import { CatalogueView } from "./catalogue-view";
import { forProducts, getOwnerFlags } from "./owner-flags";

export async function CatalogueTable({
  tenantId,
  canViewCosts = true,
  canManage = false,
  query,
}: {
  tenantId: string;
  canViewCosts?: boolean;
  canManage?: boolean;
  query: CatalogueQuery;
}) {
  // canViewCosts flows into the query: unit costs and stock values come back
  // null for a money-blind member, so the figures never reach the payload.
  // The screen counts and filters the whole catalogue server-side and returns
  // one page of rows — the chips still read across everything, only the table
  // travels.
  const [screen, categories, allOwnerFlags] = await Promise.all([
    getCatalogueScreen(tenantId, { canViewCosts, query }),
    getCustomCategories(tenantId),
    getOwnerFlags(tenantId),
  ]);

  if (screen.empty) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No products yet"
        description="Your products appear here once your Shopify catalogue has synced."
        action={
          <ButtonLink href="/settings/connections">
            Connect Shopify
          </ButtonLink>
        }
      />
    );
  }

  // The archive / keep-active switches the row editor drives: editor state rather
  // than a catalogue metric, and only for the rows actually on the page.
  const ownerFlags = forProducts(
    allOwnerFlags,
    screen.rows.map((r) => r.productId)
  );

  return (
    <CatalogueView
      screen={screen}
      query={query}
      categories={categories}
      ownerFlags={ownerFlags}
      canViewCosts={canViewCosts}
      canManage={canManage}
    />
  );
}
