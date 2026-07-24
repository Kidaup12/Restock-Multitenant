import type { LocationRole } from "@wezesha/db";
import { BoxIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue, formatNumber } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { coverTone } from "@/lib/locations/roles";
import { getStockByLocation } from "@/lib/data/stock";

const roleLabels: Record<LocationRole, string> = {
  sells: "Sells",
  holds: "Holds",
  enroute: "En route",
  ignore: "Ignore",
};

// One-line explanation of what this role does to the numbers.
const roleCaptions: Record<LocationRole, string> = {
  sells: "Counts as on-hand you can sell.",
  holds: "Warehouse stock — distributable, not counted as sellable cover.",
  enroute: "Incoming (on order) — not counted as on-hand.",
  ignore: "Excluded from every number.",
};

const dotTone = { ok: "bg-positive", warn: "bg-warning", danger: "bg-negative" } as const;

function CoverCell({ daysCover, oversold }: { daysCover: number | null; oversold: boolean }) {
  const tone = coverTone(daysCover, oversold);
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className={cn("size-2 rounded-full", dotTone[tone])} aria-hidden />
      {oversold ? (
        <span className="text-negative">Oversold</span>
      ) : daysCover === null ? (
        "—"
      ) : (
        `${daysCover}d`
      )}
    </span>
  );
}

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
            subtitle={`${location.skuCount} SKUs · ${formatNumber(location.unitsOnHand)} units on hand · ${roleCaptions[location.role]}`}
            action={
              <div className="flex items-center gap-2">
                <Badge tone={location.isPrimary ? "accent" : "neutral"}>
                  {roleLabels[location.role]}
                </Badge>
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
                  {location.showCover && <TableHead numeric>Cover</TableHead>}
                  <TableHead numeric>Value</TableHead>
                </TableHeader>
                <TableBody>
                  {location.lines.map((line) => (
                    <TableRow key={line.productId}>
                      <TableCell className="font-medium text-ink">{line.title}</TableCell>
                      <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                      <TableCell numeric className={cn(line.oversold && "text-negative")}>
                        {line.onHand}
                      </TableCell>
                      {location.showCover && (
                        <TableCell numeric>
                          <CoverCell daysCover={line.daysCover} oversold={line.oversold} />
                        </TableCell>
                      )}
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
