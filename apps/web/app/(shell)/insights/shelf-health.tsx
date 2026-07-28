import Link from "next/link";
import { getInsightsOverview } from "@/lib/data/insights";
import { AlertIcon, BoxIcon, CheckIcon, TrendDownIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Day and month, from the stored UTC date — a date-keyed row must not shift for
 *  a reader west of UTC. */
const dayLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export async function ShelfHealth({
  tenantId,
  canViewCosts,
}: {
  tenantId: string;
  canViewCosts: boolean;
}) {
  const overview = await getInsightsOverview(tenantId, { canViewCosts });
  const { stockouts, deadStock, shelfRows, cashRows, cashTotalKes } = overview;

  if (stockouts.trackedProducts === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No products tracked yet"
        description="Connect your shop or import a catalogue and this fills in overnight."
      />
    );
  }

  const missedPerDay = shelfRows.reduce((sum, r) => sum + r.missedSalesKes, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Empty right now"
          value={`${stockouts.ratePct}%`}
          delta={{
            label: `${formatNumber(stockouts.skus)} of ${formatNumber(stockouts.trackedProducts)} products`,
            tone: stockouts.skus > 0 ? "negative" : "positive",
          }}
          icon={<AlertIcon />}
        />
        <StatTile
          label="Sales going missing"
          value={<CostValue amount={missedPerDay} compact />}
          delta={{ label: "a day, while the shelf is empty", tone: "negative" }}
          icon={<TrendDownIcon />}
        />
        <StatTile
          label="Cash not moving"
          value={<CostValue amount={cashTotalKes} canViewCosts={canViewCosts} compact />}
          delta={{
            label: `${formatNumber(deadStock.skus)} products, ${deadStock.windowDays}+ days unsold`,
            tone: deadStock.skus > 0 ? "negative" : "positive",
          }}
        />
      </div>

      <Card data-tour="insights-shelves">
        <CardHeader
          title="Empty shelves right now"
          subtitle="Ranked by what they normally sell"
          action={
            shelfRows.length > 0 ? (
              <Link
                href="/plan"
                className="flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
              >
                Plan a restock
              </Link>
            ) : undefined
          }
        />
        <CardContent>
          {shelfRows.length === 0 ? (
            <EmptyState
              icon={<CheckIcon />}
              title="Nothing is out of stock"
              description="Every tracked product has something on the shelf. This is the number to keep at zero."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead numeric>Normally sells</TableHead>
                <TableHead numeric>Missing per day</TableHead>
                <TableHead numeric>Last sold</TableHead>
              </TableHeader>
              <TableBody>
                {shelfRows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <div className="font-medium text-ink">{row.title}</div>
                      <div className="text-xs text-ink-muted">{row.sku}</div>
                    </TableCell>
                    <TableCell numeric>{row.runRatePerDay.toFixed(1)}/day</TableCell>
                    <TableCell numeric>
                      <CostValue amount={row.missedSalesKes} />
                    </TableCell>
                    <TableCell numeric>
                      {row.lastSoldAt ? dayLabel(row.lastSoldAt) : "never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-tour="insights-cash">
        <CardHeader
          title="Cash asleep on the shelf"
          subtitle="Stock that isn't turning — money you could be spending on what sells"
          action={
            <CostValue
              amount={cashTotalKes}
              canViewCosts={canViewCosts}
              compact
              className="font-mono text-lg"
            />
          }
        />
        <CardContent>
          {cashRows.length === 0 ? (
            <EmptyState
              icon={<CheckIcon />}
              title="No cash asleep"
              description={`Nothing has sat unsold for ${deadStock.windowDays} days, and nothing is carrying more than ${overview.overstockCoverDays} days of cover.`}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead>Why</TableHead>
                <TableHead numeric>On hand</TableHead>
                <TableHead numeric>Cover</TableHead>
                <TableHead numeric>Cash tied up</TableHead>
              </TableHeader>
              <TableBody>
                {cashRows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <div className="font-medium text-ink">{row.title}</div>
                      <div className="text-xs text-ink-muted">{row.sku}</div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={row.reason === "not_selling" ? "negative" : "warning"}>
                        {row.reason === "not_selling" ? "Not selling" : "Way too much"}
                      </Badge>
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                    <TableCell numeric>
                      {row.coverDays == null ? (
                        <span title="No sales, so there is no cover to measure">—</span>
                      ) : (
                        `${Math.round(row.coverDays)}d`
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {row.costKnown ? (
                        <CostValue amount={row.cashKes} canViewCosts={canViewCosts} compact />
                      ) : (
                        <span title="No cost recorded for this product">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
