import { BoxIcon } from "@/components/icons";
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
import { getStockCatalogue, type CatalogueRow } from "@/lib/data/stock";
import { CatalogueExportBar } from "./catalogue-export";

/** Shelf status from on-hand + forecast cover. Cover is null before the first
 *  forecast run — those rows read "No forecast" rather than guessing. */
function status(row: CatalogueRow): { label: string; tone: "negative" | "warning" | "positive" | "neutral" } {
  if (row.onHandUnits <= 0) return { label: "Stocked out", tone: "negative" };
  if (row.daysCover === null) return { label: "No forecast", tone: "neutral" };
  if (row.daysCover < 7) return { label: "Reorder now", tone: "negative" };
  if (row.daysCover < 14) return { label: "Low", tone: "warning" };
  if (row.daysCover > 45) return { label: "Overstocked", tone: "neutral" };
  return { label: "Healthy", tone: "positive" };
}

export async function CatalogueTable({
  tenantId,
  canViewCosts = true,
}: {
  tenantId: string;
  canViewCosts?: boolean;
}) {
  // canViewCosts flows into the query: unit costs and stock values come back
  // null for a money-blind member, so the figures never reach the payload.
  const rows = await getStockCatalogue(tenantId, { canViewCosts });

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No products yet"
        description="Products appear here once a catalogue sync or import lands."
      />
    );
  }

  // The export mirrors the table: same rows, plus the status label it shows.
  const exportRows = rows.map((row) => ({
    title: row.title,
    sku: row.sku,
    onHandUnits: row.onHandUnits,
    daysCover: row.onHandUnits <= 0 ? null : row.daysCover,
    status: status(row).label,
    costKes: row.costKes,
    stockValueKes: row.stockValueKes,
  }));

  return (
    <Card>
      <CardHeader
        title="Catalogue"
        subtitle={`${rows.length} products`}
        action={<CatalogueExportBar rows={exportRows} canViewCosts={canViewCosts} />}
      />
      <CardContent className="p-0 py-2">
        <Table>
          <TableHeader>
            <TableHead>Product</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead numeric>On hand</TableHead>
            <TableHead numeric>Days cover</TableHead>
            <TableHead>Status</TableHead>
            <TableHead numeric>Stock value</TableHead>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const s = status(row);
              return (
                <TableRow key={row.productId}>
                  <TableCell className="font-medium text-ink">{row.title}</TableCell>
                  <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                  <TableCell numeric>{row.onHandUnits}</TableCell>
                  <TableCell numeric>
                    {row.onHandUnits <= 0 || row.daysCover === null ? "—" : `${row.daysCover}d`}
                  </TableCell>
                  <TableCell>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </TableCell>
                  <TableCell numeric>
                    <CostValue amount={row.stockValueKes} canViewCosts={canViewCosts} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
