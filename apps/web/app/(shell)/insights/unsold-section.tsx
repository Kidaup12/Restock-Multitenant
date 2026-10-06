import { getUnsoldStock } from "@/lib/data/today";
import { matchesAbc, type AbcKey } from "@/lib/data/abc-lens";
import { UnsoldStockView } from "./unsold-stock-view";

export async function UnsoldSection({ tenantId, canViewCosts, abc }: { tenantId: string; canViewCosts: boolean; abc: AbcKey }) {
  const stock = await getUnsoldStock(tenantId, { canViewCosts });
  return <UnsoldStockView rows={stock.rows.filter(row => matchesAbc({ abc: row.abc }, abc))} reasons={stock.reasons} canViewCosts={canViewCosts} />;
}
