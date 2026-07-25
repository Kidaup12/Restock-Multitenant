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
import { moqPreview, type MoqPreview } from "@/lib/plan/moq-preview";
import { addToOrder, clearPlanOverride, planCoverHorizon, setPlanOverride } from "./actions";

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

// Cover-days what-if control: step a uniform days-of-cover horizon and re-size
// the whole list to it. A weekly step keeps the choices meaningful; the server
// floors each line at its own lead time, so this is the range the owner explores.
const DEFAULT_WHATIF_COVER = 30;
const COVER_MIN = 7;
const COVER_MAX = 120;
const COVER_STEP = 7;

// Column class fragments — the table is a raw <table>, so headers/cells repeat
// these; the `hidden … :table-cell` variants keep the wide detail off mobile.
const TH = "px-4 py-3 text-left text-xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase";
const TH_NUM = "px-4 py-3 text-right text-xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase";
const TD = "px-4 py-3 whitespace-nowrap text-ink-secondary";
const TD_NUM = "px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap text-ink";

const dayLabel = (date: Date) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * The quantity cell: shows the number to order and, for anyone who can approve
 * orders, an inline control to override the engine's figure. When an override is
 * set the cell reads "you set N · revert to engine"; otherwise it offers a small
 * "set qty" affordance. Writes go through the tenant/permission-gated actions,
 * then the plan revalidates and the new figure streams back down.
 */
function QtyCell({ row, canOverride }: { row: BuyListRow; canOverride: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(row.recommendedQty));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canOverride) return <>{row.recommendedQty}</>;

  function save() {
    const qty = Math.round(Number(value));
    if (!Number.isFinite(qty) || qty < 1) {
      setError("1 or more");
      return;
    }
    startTransition(async () => {
      const result = await setPlanOverride({ productId: row.productId, qty });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditing(false);
    });
  }

  function revert() {
    startTransition(async () => {
      const result = await clearPlanOverride({ productId: row.productId });
      if (result.ok) setEditing(false);
    });
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            aria-label={`Order quantity for ${row.title}`}
            className="w-16 rounded-md border border-edge bg-surface px-2 py-1 text-right font-mono text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
          <Button size="sm" loading={pending} onClick={save}>
            Save
          </Button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setError(null);
              setValue(String(row.recommendedQty));
            }}
            className="text-xs font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
        {error && <span className="text-xs text-negative">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="font-medium text-ink">{row.recommendedQty}</span>
      {row.overriddenQty !== null ? (
        <span className="font-sans text-xs text-ink-muted">
          you set {row.overriddenQty} ·{" "}
          <button
            type="button"
            onClick={revert}
            disabled={pending}
            className="font-medium text-accent-ink hover:underline disabled:opacity-60"
          >
            revert to engine
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => {
            setValue(String(row.recommendedQty));
            setEditing(true);
          }}
          className="font-sans text-xs font-medium text-accent-ink hover:underline"
        >
          set qty
        </button>
      )}
    </div>
  );
}

/**
 * MOQ-floor preview under the quantity: when the supplier minimum forces the
 * order above what we'd otherwise buy, show "N → M (MOQ)"; when that floor buys
 * an uncomfortable run of cover, add a subtle "≈ X mo" warning. Quantities only,
 * so it renders for every role. The floor itself is applied at PO creation —
 * this is read-only.
 */
function MoqNote({ preview }: { preview: MoqPreview }) {
  if (!preview.roundedUp) return null;
  return (
    <span
      className="flex flex-col items-end font-sans text-xs leading-tight text-ink-muted"
      title={`Supplier minimum is ${preview.flooredQty}; the plan recommends ${preview.effectiveQty}.`}
    >
      <span>
        {preview.effectiveQty} → <span className="font-medium text-ink">{preview.flooredQty}</span> MOQ
      </span>
      {preview.badMoq && preview.monthsOfCover !== null && (
        <span className="text-warning">≈ {Math.round(preview.monthsOfCover)} mo cover</span>
      )}
    </span>
  );
}

export function BuyChecklist({
  buyList,
  canViewCosts,
  canOverride,
  backLink,
}: {
  buyList: BuyList;
  canViewCosts: boolean;
  canOverride: boolean;
  backLink: React.ReactNode;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // Cover-days what-if: null means "show the plan" (the scoped prop). Once the
  // owner steps a horizon it holds the re-sized list the server returns. The
  // re-size runs the one engine server-side; overrides and ordering still act on
  // the underlying plan, so this stays an exploration, not a second commit path.
  const [whatIf, setWhatIf] = useState<BuyList | null>(null);
  const [coverDays, setCoverDays] = useState(DEFAULT_WHATIF_COVER);
  const [resizeError, setResizeError] = useState<string | null>(null);
  const [resizing, startResize] = useTransition();

  const view = whatIf ?? buyList;
  const rows = view.rows;

  function applyCover(days: number) {
    const clamped = Math.max(COVER_MIN, Math.min(COVER_MAX, days));
    setCoverDays(clamped);
    startResize(async () => {
      const result = await planCoverHorizon({ coverDays: clamped });
      if (!result.ok) {
        setResizeError(result.error);
        return;
      }
      setResizeError(null);
      setWhatIf(result.data);
    });
  }

  function resetToPlan() {
    setWhatIf(null);
    setResizeError(null);
    setCoverDays(DEFAULT_WHATIF_COVER);
  }
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
    { header: "ABC", cell: (r) => r.abc ?? "" },
    { header: "Supplier", cell: (r) => r.supplierName ?? "" },
    { header: "MOQ", cell: (r) => r.moq },
    { header: "Lead days", cell: (r) => r.leadDays },
    { header: "In stock", cell: (r) => r.onHandUnits },
    { header: "On order", cell: (r) => r.onOrderUnits },
    { header: "Run/day", cell: (r) => r.runRatePerDay },
    { header: "Days left", cell: (r) => r.daysUntilStockout },
    { header: "Order by", cell: (r) => dayLabel(r.orderByDate) },
    { header: "Order qty", cell: (r) => r.recommendedQty },
    // Revenue is a sales figure — exported for every role.
    { header: "Revenue 30d (KES)", cell: (r) => r.revenue30dKes },
    // Money-blind members export what they see: no cost columns.
    ...(canViewCosts
      ? ([
          { header: "Unit cost (KES)", cell: (r) => r.unitCostKes },
          { header: "Line total (KES)", cell: (r) => r.lineTotalKes },
        ] satisfies ExportColumn<BuyListRow>[])
      : []),
    { header: "Why", cell: (r) => r.reasoning },
  ];

  const runDay = dayLabel(view.runDate);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">
          {rows.length} products to order · full list costs{" "}
          <CostValue amount={view.totalCostKes} canViewCosts={canViewCosts} /> · {backLink}
        </p>
        <ExportBar
          rows={rows}
          columns={exportColumns}
          filename="buy-list"
          document={{
            title: "Restock buy list",
            subtitle: `Forecast run ${runDay} · ${rows.length} products`,
            footNote: canViewCosts
              ? `Full list: KES ${Math.round(view.totalCostKes ?? 0).toLocaleString("en-KE")}`
              : undefined,
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-edge bg-surface-2/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">Size to cover</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => applyCover(coverDays - COVER_STEP)}
              disabled={resizing || coverDays <= COVER_MIN}
              aria-label="Fewer days of cover"
              className="grid size-7 place-items-center rounded-md border border-edge text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
            >
              −
            </button>
            <span className="w-20 text-center font-mono text-sm tabular-nums text-ink">
              {coverDays} days
            </span>
            <button
              type="button"
              onClick={() => applyCover(coverDays + COVER_STEP)}
              disabled={resizing || coverDays >= COVER_MAX}
              aria-label="More days of cover"
              className="grid size-7 place-items-center rounded-md border border-edge text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
            >
              +
            </button>
          </div>
          {whatIf && (
            <Badge tone="warning" className="font-sans">
              what-if
            </Badge>
          )}
        </div>
        <p className="max-w-prose text-xs text-ink-muted">
          Sizes every line to {coverDays} days of cover, never below an item&apos;s
          lead time. A what-if — for calibrated or min/max items it can differ from
          the nightly recommendation. Overrides and ordering still use the plan.
        </p>
        <div className="ml-auto flex items-center gap-3">
          {resizeError && <span className="text-xs text-negative">{resizeError}</span>}
          {whatIf && (
            <button
              type="button"
              onClick={resetToPlan}
              disabled={resizing}
              className="text-xs font-medium text-accent-ink hover:underline disabled:opacity-60"
            >
              reset to plan
            </button>
          )}
        </div>
      </div>

      {TIERS.map(({ tier, title, subtitle }) => {
        const tierRows = rows.filter((r) => r.tier === tier);
        if (tierRows.length === 0) return null;
        return (
          <Card key={tier}>
            <CardHeader title={`${title} · ${tierRows.length}`} subtitle={subtitle} />
            <div className="mt-2 w-full overflow-x-auto pb-2">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-edge">
                    <th scope="col" className="w-10 px-4 py-3" aria-label="Tick to order" />
                    <th scope="col" className={TH}>Product</th>
                    <th scope="col" className={cn(TH, "hidden md:table-cell")}>Supplier</th>
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>On order</th>
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>MOQ</th>
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>Lead</th>
                    <th scope="col" className={cn(TH_NUM, "hidden md:table-cell")}>Run/day</th>
                    <th scope="col" className={TH_NUM}>Days left</th>
                    <th scope="col" className={cn(TH, "hidden md:table-cell")}>Order by</th>
                    <th scope="col" className={TH_NUM}>Qty</th>
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>Rev · 30d (KES)</th>
                    <th scope="col" className={TH_NUM}>Line total</th>
                    <th scope="col" className="w-10 px-4 py-3" aria-label="Show reasoning" />
                  </tr>
                </thead>
                <tbody>
                  {tierRows.map((row) => {
                    const isPicked = picked.has(row.predictionId);
                    const isOpen = expanded.has(row.predictionId);
                    // Overdue keys off the run-date-relative days-left (stable across
                    // SSR/hydration), not a live clock: <= 0 means the order-by day
                    // is here or past.
                    const overdue = row.daysLeftToOrder <= 0;
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
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-ink">{row.title}</span>
                              {row.abc && <Badge tone="neutral">{row.abc}</Badge>}
                            </div>
                            <div className="mt-0.5 font-mono text-xs text-ink-muted">
                              {row.sku}
                              {row.plannable !== "ok" && (
                                <Badge tone="warning" className="ml-2 font-sans">
                                  Check cost
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className={cn(TD, "hidden md:table-cell")}>
                            {row.supplierName ?? "—"}
                          </td>
                          <td className={cn(TD_NUM, "hidden lg:table-cell")}>
                            {row.onOrderUnits > 0 ? row.onOrderUnits : "—"}
                          </td>
                          <td className={cn(TD_NUM, "hidden lg:table-cell")}>{row.moq}</td>
                          <td className={cn(TD_NUM, "hidden lg:table-cell")}>{row.leadDays}d</td>
                          <td className={cn(TD_NUM, "hidden md:table-cell")}>{row.runRatePerDay}</td>
                          <td className={TD_NUM}>
                            {row.onHandUnits <= 0 ? "—" : `${row.daysUntilStockout}d`}
                          </td>
                          <td className={cn(TD, "hidden md:table-cell")}>
                            {overdue ? (
                              <span className="font-medium text-negative">{dayLabel(row.orderByDate)}</span>
                            ) : (
                              dayLabel(row.orderByDate)
                            )}
                          </td>
                          <td className={TD_NUM}>
                            <div className="flex flex-col items-end gap-0.5">
                              <QtyCell row={row} canOverride={canOverride} />
                              <MoqNote preview={moqPreview(row)} />
                            </div>
                          </td>
                          <td className={cn(TD_NUM, "hidden lg:table-cell")}>
                            {/* Revenue is a sales figure — shown to every role as a plain
                                KES amount (unit in the header), like the Stock catalogue. */}
                            {row.revenue30dKes > 0 ? Math.round(row.revenue30dKes).toLocaleString("en-KE") : "—"}
                          </td>
                          <td className={TD_NUM}>
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
                            <td colSpan={13} className="px-4 pt-0 pb-4">
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
