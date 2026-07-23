"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { cn } from "@/lib/cn";
import type { BuyList, BuyListRow, BuyTier } from "@/lib/data/plan";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { addToOrder } from "./actions";

/**
 * Mode 1 — the tiered checklist. Tick rows, watch the running total, expand any
 * row for the arithmetic behind its quantity, then push the ticked lines to
 * Orders as pending.
 */

const TIERS: { tier: BuyTier; title: string; subtitle: string }[] = [
  {
    tier: "order_today",
    title: "Order today",
    subtitle: "Past the last safe day — order now or stock out before the delivery lands.",
  },
  {
    tier: "this_week",
    title: "This week",
    subtitle: "The last safe day to order is inside the next 7 days.",
  },
  {
    tier: "can_wait",
    title: "Can wait",
    subtitle: "Ordering later is still safe — this money can go elsewhere first.",
  },
];

const PLANNABLE_NOTES: Record<string, string> = {
  "missing-cost": "No unit cost on file — the line total can't be trusted.",
  "missing-price": "No selling price on file — margin can't be checked.",
  "cost-exceeds-price": "Cost is above the selling price — restocking this loses money.",
};

export function BuyChecklist({
  buyList,
  canViewCosts,
  backLink,
}: {
  buyList: BuyList;
  canViewCosts: boolean;
  backLink: React.ReactNode;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const rows = buyList.rows;
  // Line totals are null for money-blind members; the total masks with them.
  const pickedTotalKes = useMemo(
    () =>
      rows.reduce(
        (sum, r) => (picked.has(r.predictionId) ? sum + (r.lineTotalKes ?? 0) : sum),
        0
      ),
    [rows, picked]
  );

  function toggleSet(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function submit() {
    const predictionIds = [...picked];
    startTransition(async () => {
      const result = await addToOrder({ predictionIds });
      if (!result.ok) {
        setNotice({ kind: "err", text: result.error });
        return;
      }
      const { created, updated } = result.data;
      const lines = created + updated;
      setNotice({
        kind: "ok",
        text: `${lines} ${lines === 1 ? "line" : "lines"} added to Orders as pending.`,
      });
      setPicked(new Set());
    });
  }

  const exportColumns: ExportColumn<BuyListRow>[] = [
    { header: "Tier", cell: (r) => TIERS.find((t) => t.tier === r.tier)?.title ?? r.tier },
    { header: "SKU", cell: (r) => r.sku },
    { header: "Product", cell: (r) => r.title },
    { header: "Supplier", cell: (r) => r.supplierName ?? "" },
    { header: "In stock", cell: (r) => r.onHandUnits },
    { header: "Days left", cell: (r) => r.daysUntilStockout },
    { header: "Order qty", cell: (r) => r.recommendedQty },
    // Money-blind members export what they see: no cost columns.
    ...(canViewCosts
      ? ([
          { header: "Unit cost (KES)", cell: (r) => r.unitCostKes },
          { header: "Line total (KES)", cell: (r) => r.lineTotalKes },
        ] satisfies ExportColumn<BuyListRow>[])
      : []),
    { header: "Why", cell: (r) => r.reasoning },
  ];

  const runDay = new Date(buyList.runDate).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">
          {rows.length} products to order · full list costs{" "}
          <CostValue amount={buyList.totalCostKes} canViewCosts={canViewCosts} /> · {backLink}
        </p>
        <ExportBar
          rows={rows}
          columns={exportColumns}
          filename="buy-list"
          document={{
            title: "Restock buy list",
            subtitle: `Forecast run ${runDay} · ${rows.length} products`,
            footNote: canViewCosts
              ? `Full list: KES ${Math.round(buyList.totalCostKes ?? 0).toLocaleString("en-KE")}`
              : undefined,
          }}
        />
      </div>

      {TIERS.map(({ tier, title, subtitle }) => {
        const tierRows = rows.filter((r) => r.tier === tier);
        if (tierRows.length === 0) return null;
        return (
          <Card key={tier}>
            <CardHeader title={`${title} · ${tierRows.length}`} subtitle={subtitle} />
            <div className="mt-2 w-full overflow-x-auto pb-2">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-edge">
                    <th scope="col" className="w-10 px-4 py-3" aria-label="Tick to order" />
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase">
                      Product
                    </th>
                    <th scope="col" className="hidden px-4 py-3 text-left text-xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase md:table-cell">
                      Supplier
                    </th>
                    <th scope="col" className="px-4 py-3 text-right text-xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase">
                      Days left
                    </th>
                    <th scope="col" className="px-4 py-3 text-right text-xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase">
                      Qty
                    </th>
                    <th scope="col" className="px-4 py-3 text-right text-xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase">
                      Line total
                    </th>
                    <th scope="col" className="w-10 px-4 py-3" aria-label="Show reasoning" />
                  </tr>
                </thead>
                <tbody>
                  {tierRows.map((row) => {
                    const isPicked = picked.has(row.predictionId);
                    const isOpen = expanded.has(row.predictionId);
                    return (
                      <Fragment key={row.predictionId}>
                        <tr
                          className={cn(
                            "border-b border-edge transition-colors hover:bg-surface-2/60",
                            isOpen && "border-b-0"
                          )}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={isPicked}
                              onChange={() => {
                                setPicked((p) => toggleSet(p, row.predictionId));
                                setNotice(null);
                              }}
                              aria-label={`Order ${row.title}`}
                              className="size-4 accent-accent"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-ink">{row.title}</div>
                            <div className="mt-0.5 font-mono text-xs text-ink-muted">
                              {row.sku}
                              {row.plannable !== "ok" && (
                                <Badge tone="warning" className="ml-2 font-sans">
                                  Check cost
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="hidden px-4 py-3 whitespace-nowrap text-ink-secondary md:table-cell">
                            {row.supplierName ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap text-ink">
                            {row.onHandUnits <= 0 ? "—" : `${row.daysUntilStockout}d`}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap text-ink">
                            {row.recommendedQty}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap text-ink">
                            <CostValue amount={row.lineTotalKes} canViewCosts={canViewCosts} />
                          </td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              onClick={() => setExpanded((e) => toggleSet(e, row.predictionId))}
                              aria-expanded={isOpen}
                              aria-label={`Why ${row.recommendedQty} units of ${row.title}`}
                              className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                            >
                              <ChevronDownIcon
                                className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                              />
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-edge">
                            <td colSpan={7} className="px-4 pt-0 pb-4">
                              <div className="rounded-md bg-surface-2/60 px-4 py-3 text-sm">
                                <p className="font-mono text-xs text-ink">
                                  {row.explain?.summary ?? row.qtySummary}
                                </p>
                                <p className="mt-2 text-ink-secondary">{row.reasoning}</p>
                                {row.plannable !== "ok" && (
                                  <p className="mt-2 text-warning">
                                    {PLANNABLE_NOTES[row.plannable]}
                                  </p>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      {(picked.size > 0 || notice) && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 shadow-pop">
          {picked.size > 0 && (
            <span className="text-sm font-medium text-ink">
              {picked.size} ticked ·{" "}
              <CostValue amount={pickedTotalKes} canViewCosts={canViewCosts} className="font-mono" />
            </span>
          )}
          {notice && (
            <span
              className={cn("text-sm", notice.kind === "err" ? "text-negative" : "text-positive")}
            >
              {notice.text}
            </span>
          )}
          <span className="ml-auto" />
          {picked.size > 0 && (
            <Button size="sm" loading={pending} onClick={submit}>
              Add {picked.size} to order
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
