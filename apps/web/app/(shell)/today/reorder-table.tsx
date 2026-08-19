import Link from "next/link";
import { BulbIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { planFreshnessLabel } from "@/lib/data/forecast-freshness";
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
  // canViewCosts flows into the query: order costs come back null for a
  // money-blind member, so the figures never reach the payload.
  const reorder = await getReorderNeeded(tenantId, { canViewCosts });

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

  // Same freshness rule as the planner, so the two screens never disagree about
  // how old the plan is.
  const freshness = planFreshnessLabel(reorder.runDate);

  // The count is every product needing restocking, not the handful this card
  // has room for — the planner reports the same number, and the two screens
  // must not disagree on the first question of the morning.
  const capped = reorder.rows.length < reorder.needingRestock;
  const subtitle =
    `${reorder.needingRestock} of ${reorder.totalPredicted} forecast products need restocking` +
    (capped ? ` · ${reorder.rows.length} most urgent shown` : "") +
    ` · ${freshness.short}`;

  return (
    <>
      {reorder.criticalCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-accent-soft p-3 text-sm text-accent-ink">
          <span>
            <span className="font-medium">
              {reorder.criticalCount} critical{" "}
              {reorder.criticalCount === 1 ? "item is" : "items are"} at or near zero stock
            </span>{" "}
            — quantities account for cover, lead time and what is already on the way.
          </span>
          {/* Lands on the buy list already narrowed to these, so the link
              delivers what it says rather than the whole plan. */}
          <Link
            href="/plan?mode=list&urgent=1"
            className="font-medium underline-offset-2 hover:underline"
          >
            Reorder critical →
          </Link>
        </div>
      )}

    <Card>
      <CardHeader
        title="Reorder needed"
        subtitle={subtitle}
        action={
          <Link href="/plan" className="text-sm font-medium text-accent-ink hover:underline">
            Open Restock planner
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
              {/* No quantity or order cost here. This screen says what needs
                  attention; deciding how much to buy is the planner's job,
                  where the budget and horizon that size an order live. A
                  number here invites ordering against a figure the shop never
                  set. */}
              <TableHead>Urgency</TableHead>
            </TableHeader>
            <TableBody>
              {reorder.rows.map((row) => {
                const badge = urgencyBadge[row.urgency] ?? urgencyBadge.low!;
                return (
                  <TableRow key={row.productId}>
                    <TableCell className="font-medium text-ink">{row.title}</TableCell>
                    <TableCell numeric>{row.onHandUnits}</TableCell>
                    <TableCell numeric>
                      {row.onHandUnits <= 0 || row.daysUntilStockout == null
                        ? "—"
                        : `${row.daysUntilStockout}d`}
                    </TableCell>
                    <TableCell>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
    </>
  );
}
