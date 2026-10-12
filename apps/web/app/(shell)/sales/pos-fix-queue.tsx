import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { getPosMatchProducts, getUnmatchedPosSkus } from "@/lib/data/pos-queues";
import { UnmatchedRow } from "./unmatched-row";

/**
 * The unmatched-POS fix queue: till SKUs that matched no product, with units +
 * revenue that would otherwise be invisible (spec §3 — dropped till lines make a
 * branch look slower than it is). Hidden entirely when there is nothing to fix.
 *
 * Open to every role: matching a till SKU to a product is shop-floor work, not
 * an admin judgment call — the person at the till is the one who knows what it is.
 */
export async function PosFixQueue({ tenantId }: { tenantId: string }) {
  const rows = await getUnmatchedPosSkus(tenantId);
  if (rows.length === 0) return null;

  const products = await getPosMatchProducts(tenantId);
  const totalRevenue = rows.reduce((sum, r) => sum + r.revenueKes, 0);

  return (
    <Card>
      <CardHeader
        title="Unmatched till sales"
        subtitle="These physical sales match no product, so they don't count toward run rate yet. Match them or mark them not-a-product."
        action={
          <Badge tone="warning">
            {rows.length} SKU{rows.length === 1 ? "" : "s"} · <CostValue amount={totalRevenue} />
          </Badge>
        }
      />
      <ul className="mt-3 pb-1">
        {rows.map((row) => (
          <UnmatchedRow key={row.sku} row={row} products={products} />
        ))}
      </ul>
    </Card>
  );
}
