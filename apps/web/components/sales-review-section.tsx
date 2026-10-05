import { getSpikeSuggestions } from "@/lib/data/signals";
import { SpikeSuggestions } from "@/app/(shell)/settings/signals/spike-suggestions";

/** Shared review surface: discovery on Today, a larger queue on Sales, and
 * product-specific evidence on the catalogue detail page. Detection is always
 * available, regardless of whether optional bulk damping is enabled.
 */
export async function SalesReviewSection({ tenantId, canManage, productId, limit = 5, reviewLink = true }: {
  tenantId: string; canManage: boolean; productId?: string; limit?: number; reviewLink?: boolean;
}) {
  const suggestions = await getSpikeSuggestions(tenantId, new Date(), { productId, limit });
  return <SpikeSuggestions suggestions={suggestions} canManage={canManage} limit={limit} reviewLink={reviewLink} />;
}
