import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber } from "@/components/ui/cost-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getTopProducts } from "@/lib/data/sales";
import { TopProductsExportBar } from "./top-products-export";

export async function TopProducts({ tenantId }: { tenantId: string }) {
  const rows = await getTopProducts(tenantId, { days: 30, limit: 10 });

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader title="Top products, 30 days" />
        <CardContent>
          <EmptyState
            title="No sales in the last 30 days"
            description="Your best sellers rank here once sales land."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Top products, 30 days"
        subtitle="Ranked by revenue, all channels"
        action={<TopProductsExportBar rows={rows} />}
      />
      <div className="mt-2 pb-2">
        <Table>
          <TableHeader>
            <TableHead>Product</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead numeric>Units</TableHead>
            <TableHead numeric>Revenue (KES)</TableHead>
            <TableHead numeric>Run rate</TableHead>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.productId}>
                <TableCell className="font-medium text-ink">{row.title}</TableCell>
                <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                <TableCell numeric>{formatNumber(row.unitsSold)}</TableCell>
                <TableCell numeric>{formatNumber(row.revenueKes)}</TableCell>
                <TableCell numeric>{row.runRate.toFixed(1)}/day</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
