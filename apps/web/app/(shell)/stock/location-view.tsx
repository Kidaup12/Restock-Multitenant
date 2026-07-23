import { BoxIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue, formatNumber } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getStockByLocation } from "@/lib/data/stock";

const typeLabels: Record<string, string> = {
  branch: "Branch",
  warehouse: "Warehouse",
  virtual: "Virtual",
  enroute: "En route",
};

export async function LocationView({
  tenantId,
  canViewCosts = true,
}: {
  tenantId: string;
  canViewCosts?: boolean;
}) {
  // canViewCosts flows into the query: per-line and per-location values come
  // back null for a money-blind member, so the figures never reach the payload.
  const locations = await getStockByLocation(tenantId, { canViewCosts });

  if (locations.length === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No locations yet"
        description="Locations arrive with the first inventory sync."
      />
    );
  }

  return (
    <div className="space-y-6">
      {locations.map((location) => (
        <Card key={location.locationId}>
          <CardHeader
            title={location.name}
            subtitle={`${location.skuCount} SKUs · ${formatNumber(location.unitsOnHand)} units on hand`}
            action={
              <div className="flex items-center gap-2">
                {location.locationType && (
                  <Badge tone={location.isPrimary ? "accent" : "neutral"}>
                    {typeLabels[location.locationType] ?? location.locationType}
                  </Badge>
                )}
                <CostValue
                  amount={location.stockValueKes}
                  canViewCosts={canViewCosts}
                  compact
                  className="text-sm font-medium text-ink"
                />
              </div>
            }
          />
          <div className="mt-2 pb-2">
            {location.lines.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-ink-muted">Nothing on hand here.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead numeric>On hand</TableHead>
                  <TableHead numeric>Value</TableHead>
                </TableHeader>
                <TableBody>
                  {location.lines.map((line) => (
                    <TableRow key={line.productId}>
                      <TableCell className="font-medium text-ink">{line.title}</TableCell>
                      <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                      <TableCell numeric>{line.onHand}</TableCell>
                      <TableCell numeric>
                        <CostValue amount={line.valueKes} canViewCosts={canViewCosts} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
