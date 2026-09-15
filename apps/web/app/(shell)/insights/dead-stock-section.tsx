import { getInsightsOverview } from "@/lib/data/insights";
import { matchesAbc, type AbcKey } from "@/lib/data/abc-lens";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatNumber } from "@/lib/money";
import { cols } from "@/lib/export/print-pdf";
import { ExportPdfButton } from "./export-pdf-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeadStockExportBar } from "./dead-stock-export";

/**
 * Dead stock, on its own.
 *
 * The "Cash asleep on the shelf" table (shelf-health) blends two piles: stock
 * that has stopped selling (`not_selling`) and stock still selling but
 * over-bought (`too_much`). This section pulls out only the first — the truly
 * dead — because they need different actions: dead stock gets discounted or
 * stops being reordered, over-bought stock just slows down. Reading them apart
 * is the whole point of a dedicated section.
 *
 * No new loader and no second cost getter: it reads `getInsightsOverview`, the
 * same already-registered cost surface shelf-health uses, and filters its rows
 * to the not-selling reason. Cost redaction therefore rides in for free — a
 * money-blind caller's `cashKes` is already null on the way in, `costKnown`
 * still says whether a cost exists, and the CSV/PDF drop the column outright.
 *
 * The per-class chips are computed from the SHOWN rows, not a separate query, so
 * the A·B·C tallies and the table below can never disagree — the same reason
 * shelf-health derives everything it renders from one filtered list.
 */
export async function DeadStockSection({
  tenantId,
  currency,
  canViewCosts,
  abc,
}: {
  tenantId: string;
  currency: string;
  canViewCosts: boolean;
  /** The A/B/C lens from the URL. Filters the table, the chips and both exports. */
  abc: AbcKey;
}) {
  const overview = await getInsightsOverview(tenantId, { canViewCosts });
  const { deadStock } = overview;

  // The dead pile only — over-bought stock lives in its own section. Filtered by
  // the same lens before anything reads it, so the chips, the table and both
  // exports show one list rather than three views of different rows.
  const deadRows = overview.cashRows.filter(
    (r) => r.reason === "not_selling" && matchesAbc(r, abc)
  );
  // The full dead list for the CSV — every not-selling row the server ranked,
  // not the page above — reusing the cash export (it carries the vendor and the
  // plain-words action) and honouring the same lens.
  const deadExportRows = overview.cashExport.filter(
    (r) => r.risk === "Not selling" && matchesAbc(r, abc)
  );

  // Per-class tallies from the shown rows: count and capital tied up for each of
  // A, B and C. A dead A-line is a bestseller nobody buys any more and a dead
  // C-line is a rounding error, so the classes are worth showing apart. Unrated
  // is folded into a fourth chip only when it carries anything, so a classified
  // shop never sees an empty "unrated 0".
  type ClassKey = "A" | "B" | "C" | "unrated";
  const CLASS_ORDER: ClassKey[] = ["A", "B", "C", "unrated"];
  const tally: Record<ClassKey, { count: number; cashKes: number; costKnown: boolean }> = {
    A: { count: 0, cashKes: 0, costKnown: false },
    B: { count: 0, cashKes: 0, costKnown: false },
    C: { count: 0, cashKes: 0, costKnown: false },
    unrated: { count: 0, cashKes: 0, costKnown: false },
  };
  for (const r of deadRows) {
    const key: ClassKey = r.abc === "A" || r.abc === "B" || r.abc === "C" ? r.abc : "unrated";
    tally[key].count += 1;
    if (r.costKnown && r.cashKes != null) {
      tally[key].cashKes += r.cashKes;
      tally[key].costKnown = true;
    }
  }
  // A and B carrying dead stock is the alarming case — money frozen in what
  // should be your best-selling classes — so those chips warn; C and unrated
  // sit neutral.
  const chipTone = (key: ClassKey, count: number): "warning" | "neutral" =>
    count > 0 && (key === "A" || key === "B") ? "warning" : "neutral";

  // The PDF mirrors the on-screen columns and honours the same cost redaction —
  // a money-blind caller's rows never carry a capital figure. Rebuilt from the
  // same rows the table renders, so the PDF can't drift from the screen.
  const headers = ["Product", "SKU", "Class", "On hand"];
  const pdf = {
    columns: cols(canViewCosts ? [...headers, "Capital tied up"] : headers, [3, 4]),
    rows: deadRows.map((r) => [
      r.title,
      r.sku,
      r.abc ?? "—",
      formatNumber(r.onHandUnits),
      ...(canViewCosts
        ? [r.costKnown && r.cashKes != null ? formatMoney(r.cashKes, currency) : "—"]
        : []),
    ]),
  };

  return (
    <Card data-tour="insights-dead-stock">
      <CardHeader
        title={`Dead stock${deadRows.length > 0 ? ` · ${formatNumber(deadRows.length)}` : ""}`}
        subtitle={`No sales in ${deadStock.windowDays}d · at cost`}
        action={
          deadRows.length > 0 ? (
            <div className="flex items-center gap-3">
              {/* The CSV is every dead row, not the paged table above — offered
                  wherever the list is, gated to any authenticated member (the
                  capital column drops for a money-blind one). */}
              {deadExportRows.length > 0 && (
                <DeadStockExportBar rows={deadExportRows} canViewCosts={canViewCosts} />
              )}
              <ExportPdfButton
                title="Dead stock"
                subtitle={`No sales in ${deadStock.windowDays} days`}
                columns={pdf.columns}
                rows={pdf.rows}
              />
            </div>
          ) : undefined
        }
      />
      <CardContent className="space-y-4">
        {deadRows.length === 0 ? (
          <EmptyState
            title={
              abc === "all"
                ? "No dead stock — nice."
                : abc === "unrated"
                  ? "No unrated dead stock."
                  : `No Class ${abc} dead stock.`
            }
            description={
              abc === "all"
                ? `Nothing has sat unsold for ${deadStock.windowDays} days. This is the number to keep at zero.`
                : `Nothing in this class has sat unsold for ${deadStock.windowDays} days.`
            }
          />
        ) : (
          <>
            {/* Count and capital per class, worst classes first. */}
            <div className="flex flex-wrap items-center gap-2">
              {CLASS_ORDER.filter((key) => key !== "unrated" || tally[key].count > 0).map((key) => (
                <Badge key={key} tone={chipTone(key, tally[key].count)}>
                  {key === "unrated" ? "Unrated" : key} · {formatNumber(tally[key].count)} ·{" "}
                  <CostValue
                    amount={tally[key].costKnown ? tally[key].cashKes : null}
                    canViewCosts={canViewCosts}
                    compact
                  />
                </Badge>
              ))}
            </div>

            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead>Class</TableHead>
                <TableHead numeric>Stock</TableHead>
                <TableHead numeric>Capital tied up</TableHead>
              </TableHeader>
              <TableBody>
                {deadRows.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <div className="font-medium text-ink">{row.title}</div>
                      <div className="text-xs text-ink-muted">{row.sku}</div>
                    </TableCell>
                    <TableCell>
                      {row.abc ? (
                        <Badge tone="neutral">{row.abc}</Badge>
                      ) : (
                        <span className="text-xs text-ink-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.onHandUnits)}</TableCell>
                    <TableCell numeric>
                      {row.costKnown ? (
                        <CostValue
                          amount={row.cashKes}
                          canViewCosts={canViewCosts}
                          compact
                          // Red only when the figure is actually shown — a masked
                          // value is withheld, not a loss to colour, and CostValue
                          // dims the glyphs itself.
                          className={canViewCosts ? "text-negative" : undefined}
                        />
                      ) : (
                        <span title="No cost recorded for this product">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
