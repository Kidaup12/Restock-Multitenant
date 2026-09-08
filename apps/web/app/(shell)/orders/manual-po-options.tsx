import { getManualPoOptions } from "@/lib/data/orders";
import { ManualPoForm } from "./manual-po-form";

/** Loads the supplier/product options for the hand-built order form. Split from
 *  the form so the query streams behind its own boundary and the queue above it
 *  is never held up by it. */
export async function ManualPoOptions({
  tenantId,
  canViewCosts,
}: {
  tenantId: string;
  canViewCosts: boolean;
}) {
  const suppliers = await getManualPoOptions(tenantId, { canViewCosts });
  return <ManualPoForm suppliers={suppliers} canViewCosts={canViewCosts} />;
}
