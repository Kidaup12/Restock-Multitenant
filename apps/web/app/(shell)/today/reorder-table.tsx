import Link from "next/link";
import { BulbIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getReorderNeeded } from "@/lib/data/today";

const urgencyBadge: Record<string, { label: string; tone: "negative" | "warning" | "accent" | "neutral" }> = {
  critical: { label: "Critical", tone: "negative" },
  high: { label: "High", tone: "warning" },
  medium: { label: "Medium", tone: "accent" },
  low: { label: "Low", tone: "neutral" },
};

export async function ReorderTable({
  tenantId,
  canViewCosts = true,
}: {
  tenantId: string;
  canViewCosts?: boolean;
}) {
  const reorder = await getReorderNeeded(tenantId);

  if (!reorder) {
    return (
      <Card>
        <CardHeader title="Reorder needed" subtitle="What the forecast would order today" />
        <CardContent>
          <EmptyState
            icon={<BulbIcon />}
            title="No forecast yet"
            description="Run the forecast to rank every product by stockout risk and get order quantities."
          />
        </CardContent>
      </Card>
    );
  }

  const runDay = reorder.runDate.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

  return (
    <Card>
      <CardHeader
        title="Reorder needed"
        subtitle={`${reorder.rows.length} of ${reorder.totalPredicted} forecast products · run ${runDay}`}
        action={
          <Link href="/stock" className="text-sm font-medium text-accent-ink hover:underline">
            View all
          </Link>
        }
      />
      <div className="mt-2 pb-2">
        {reorder.rows.length === 0 ? (
          <CardContent>
            <EmptyState
              title="Nothing to reorder"
              description="No product needs an order right now — the next run may change that."
            />
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableHead>Product</TableHead>
              <TableHead numeric>In stock</TableHead>
              <TableHead numeric>Days cover</TableHead>
              <TableHead>Urgency</TableHead>
              <TableHead numeric>Reorder qty</TableHead>
              <TableHead numeric>Order cost</TableHead>
            </TableHeader>
            <TableBody>
              {reorder.rows.map((row) => {
                const badge = urgencyBadge[row.urgency] ?? urgencyBadge.low!;
                return (
                  <TableRow key={row.productId}>
                    <TableCell className="font-medium text-ink">{row.title}</TableCell>
                    <TableCell numeric>{row.onHandUnits}</TableCell>
                    <TableCell numeric>
                      {row.onHandUnits <= 0 ? "—" : `${row.daysUntilStockout}d`}
                    </TableCell>
                    <TableCell>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell numeric>{row.recommendedQty || "—"}</TableCell>
                    <TableCell numeric>
                      {row.recommendedQty > 0 ? (
                        <CostValue amount={row.orderCostKes} canViewCosts={canViewCosts} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  );
}
