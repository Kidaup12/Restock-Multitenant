"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatMoney, formatNumber } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import { cn } from "@/lib/cn";
import { ActionBar } from "@/components/ui/action-bar";
import type {
  BuyList,
  BuyListRow,
  BuyTier,
  ExcludedReason,
  ExcludedRow,
  PlanColdStart,
  PlanConfidence,
} from "@/lib/data/plan";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { moqPreview, type MoqPreview } from "@/lib/plan/moq-preview";
import {
  COVER_MAX,
  COVER_MIN,
  COVER_STEP,
  DEFAULT_COVER_DAYS,
  clampCoverDays,
} from "./cover";
import { Stepper } from "@/components/ui/stepper";
import { LeadFlooredNote } from "./lead-floored-note";
import {
  addToOrder,
  clearPlanOverride,
  planCoverHorizon,
  planSalesTarget,
  setPlanOverride,
} from "./actions";

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

/**
 * How the rows are ordered inside each tier. "Plan order" is the order the run
 * itself produced (bestsellers first) — the default, and the only one that
 * needs no client work.
 *
 * `costly` is the one key that reads a cost field, so it is offered only to a
 * caller who may see costs. Sorting a money-blind member's list by line total
 * would hand back the cost ranking the data layer just spent a re-sort hiding.
 */
type SortKey = "plan" | "urgent" | "fastest" | "revenue" | "alpha" | "costly";

const SORTS: { key: SortKey; label: string; needsCosts?: true }[] = [
  { key: "plan", label: "Plan order (bestsellers first)" },
  { key: "urgent", label: "Most urgent" },
  { key: "fastest", label: "Fastest-selling" },
  { key: "revenue", label: "Highest 30d revenue" },
  { key: "costly", label: "Biggest line total", needsCosts: true },
  { key: "alpha", label: "A → Z" },
];

/** Non-mutating; "plan" hands back the same array so the run's own order is
 *  passed through untouched rather than re-derived. */
function sortRows(rows: BuyListRow[], key: SortKey): BuyListRow[] {
  if (key === "plan") return rows;
  const copy = [...rows];
  switch (key) {
    case "urgent":
      return copy.sort((a, b) => a.daysLeftToOrder - b.daysLeftToOrder);
    case "fastest":
      return copy.sort((a, b) => b.runRatePerDay - a.runRatePerDay);
    case "revenue":
      return copy.sort((a, b) => b.revenue30dKes - a.revenue30dKes);
    case "costly":
      return copy.sort((a, b) => (b.lineTotalKes ?? 0) - (a.lineTotalKes ?? 0));
    case "alpha":
      return copy.sort((a, b) => a.title.localeCompare(b.title));
  }
}

const PLANNABLE_NOTES: Record<string, string> = {
  "missing-cost": "No unit cost on file — the line total can't be trusted.",
  "missing-price": "No selling price on file — margin can't be checked.",
  "cost-exceeds-price": "Cost is above the selling price — restocking this loses money.",
};

// The "Not on the buy list" section below the tiers: every product the run
// covered but isn't asking anyone to order, grouped by why. Read-only. The last
// two groups carry no quantity — the run sized them to nothing — and until they
// were surfaced the owner had no way to find out why a product was missing.
export const EXCLUDED_GROUPS: { reason: ExcludedReason; title: string; subtitle: string }[] = [
  {
    reason: "already-ordered",
    title: "Already on the way",
    subtitle: "These already have an open order in progress — the plan isn't ordering them again.",
  },
  {
    reason: "covered",
    title: "You already have enough",
    subtitle:
      "What's on the shelf plus what's coming already covers what these are expected to sell.",
  },
  {
    reason: "too-new",
    title: "Too new to forecast",
    subtitle:
      "These haven't been on the shelf long enough to have a sales pattern yet. Give them a few weeks of sales, or tell us what to expect.",
  },
  {
    reason: "slow-mover",
    title: "Too slow to stock now",
    subtitle: "Plenty of cover and selling slowly — the cash is better spent elsewhere first.",
  },
  {
    reason: "unplannable",
    title: "Cost needs checking",
    subtitle: "Missing or broken cost data — fix the numbers and they rejoin the list.",
  },
];

/** Groups whose rows carry a quantity worth showing. The zero-sized ones render
 *  a narrower table — a column of 0 and KES 0 is noise, not information. */
const QTY_GROUPS = new Set<ExcludedReason>(["already-ordered", "unplannable", "slow-mover"]);

// The run's own honesty words, in shop language. The engine's tokens
// ("fairly_sure", "min_max") must never reach a screen.
export const CONFIDENCE_COPY: Record<
  PlanConfidence,
  { chip: string; tone: "positive" | "neutral" | "warning"; sentence: string }
> = {
  sure: {
    chip: "Sure",
    tone: "positive",
    sentence:
      "A steady seller with a long, clean sales record — this number is as good as we get.",
  },
  fairly_sure: {
    chip: "Fairly sure",
    tone: "neutral",
    sentence:
      "Enough sales history to be useful, but something is unsettled — a short record, uneven weeks, or a promotion running.",
  },
  guessing: {
    chip: "Guessing",
    tone: "warning",
    sentence:
      "Not enough clean sales history to be confident. Treat this as a starting point and use your own judgement.",
  },
};

export const COLD_START_COPY: Record<PlanColdStart, { chip: (from: string | null) => string; sentence: (from: string | null) => string }> = {
  too_new: {
    chip: () => "Too new",
    sentence: () =>
      "This product hasn't been on the shelf long enough to have a sales pattern yet.",
  },
  borrowed: {
    chip: (from) => (from ? `Selling like ${from}` : "Selling like a similar product"),
    sentence: (from) =>
      `Too new to have its own sales pattern, so we've borrowed the shape of ${from ?? "a similar product that already sells well"} and scaled it to this product's price.`,
  },
};

/** What set the target, keyed on the run's own method — this is what keeps the
 *  word "min_max" off the screen. */
export const SIZING_RULE_COPY: Record<string, string> = {
  mean_cover: "Sized to cover sales until the next delivery lands, plus a buffer.",
  calibrated:
    "Sized so you rarely run out — enough to cover the wait for a delivery, at the service level set for this class.",
  min_max:
    "Topped up to a simple two-week shelf level. This one sells too slowly and too unevenly to forecast precisely, so we keep a steady level instead of chasing a number.",
};

/** How far to trust the number, beside the product it belongs to. Absent when
 *  the run predates the trust columns, so an old plan simply says nothing rather
 *  than claiming confidence it never recorded. */
export function TrustChips({ row }: { row: Pick<BuyListRow, "confidence" | "coldStart" | "borrowedFromTitle"> }) {
  const confidence = row.confidence ? CONFIDENCE_COPY[row.confidence] : null;
  const cold = row.coldStart ? COLD_START_COPY[row.coldStart] : null;
  if (!confidence && !cold) return null;
  return (
    <>
      {confidence && <Badge tone={confidence.tone}>{confidence.chip}</Badge>}
      {cold && <Badge tone="neutral">{cold.chip(row.borrowedFromTitle)}</Badge>}
    </>
  );
}

/** The same two facts in full sentences, inside the "why this quantity" panel. */
function TrustNotes({ row }: { row: Pick<BuyListRow, "confidence" | "coldStart" | "borrowedFromTitle"> }) {
  const confidence = row.confidence ? CONFIDENCE_COPY[row.confidence] : null;
  const cold = row.coldStart ? COLD_START_COPY[row.coldStart] : null;
  if (!confidence && !cold) return null;
  return (
    <>
      {confidence && <p className="mt-2 text-ink-secondary">{confidence.sentence}</p>}
      {cold && <p className="mt-2 text-ink-secondary">{cold.sentence(row.borrowedFromTitle)}</p>}
    </>
  );
}

/**
 * The "why this number" panel. Arithmetic first — that is the part no heading
 * can give — then the run's own words. Shared by the tier rows and the held-back
 * ones so a product's explanation has one wording wherever it appears.
 */
function WhyPanel({ row }: { row: BuyListRow }) {
  return (
    <div className="rounded-md bg-surface-2/60 px-4 py-3 text-sm">
      <p className="font-mono text-xs text-ink">{row.explain?.summary ?? row.qtySummary}</p>
      {row.explain && SIZING_RULE_COPY[row.explain.method] && (
        <p className="mt-2 text-ink-secondary">{SIZING_RULE_COPY[row.explain.method]}</p>
      )}
      <p className="mt-2 text-ink-secondary">{row.reasoning}</p>
      <TrustNotes row={row} />
      {row.plannable !== "ok" && <p className="mt-2 text-warning">{PLANNABLE_NOTES[row.plannable]}</p>}
    </div>
  );
}

/**
 * A group heading speaks for the whole group; when a row's own honesty words
 * undercut it, the row has to say so where the heading is read, not inside a
 * panel nobody opened. Only "You already have enough" makes a claim strong
 * enough to need this: a product whose forecast is borrowed or shaky is covered
 * against a guess, and the shelf-plus-incoming numbers below say against what.
 */
function coveredCaveat(row: ExcludedRow): string | null {
  if (row.reason !== "covered") return null;
  if (row.coldStart === "borrowed") {
    return `Enough for now — though that's measured against an estimate borrowed from ${
      row.borrowedFromTitle ?? "a similar product"
    }, not this product's own sales.`;
  }
  if (row.coldStart === "too_new" || row.confidence === "guessing") {
    return "Enough for now — though there's little sales history behind that estimate, so keep an eye on it.";
  }
  return null;
}

// Cover-days what-if control: step a uniform days-of-cover horizon and re-size
// the whole list to it. A weekly step keeps the choices meaningful; the server
// floors each line at its own lead time, so this is the range the owner explores.
// The range itself lives in ./cover — the budget allocator offers the same one.

// Sales-push what-if control: step a uniform demand uplift (whole percent) and
// re-size the whole list to the lifted demand — planning for a promotion or
// season. The server re-sizes on the same engine over each item's own cover.
const DEFAULT_WHATIF_UPLIFT = 0;
const UPLIFT_MIN = 0;
const UPLIFT_MAX = 100;
const UPLIFT_STEP = 10;

// Column class fragments — the table is a raw <table>, so headers/cells repeat
// these; the `hidden … :table-cell` variants keep the wide detail off mobile.
// Kept in step with components/ui/table.tsx by hand: this table is raw because
// its rows expand, and a reader should not be able to tell which one they are on.
const TH = "px-5 py-3 text-left text-2xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase";
const TH_NUM = "px-5 py-3 text-right text-2xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase";
const TD = "px-5 py-3 whitespace-nowrap text-ink-secondary";
const TD_NUM = "px-5 py-3 text-right font-mono tabular-nums whitespace-nowrap text-ink";

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

/**
 * The "Excluded" section: products the run sized but held off the active list,
 * grouped by why. Read-only — no ticking, no override — so it reads as context,
 * not a second buy list. Costs redact through the same CostValue as the tiers.
 */
export function ExcludedSection({
  excluded,
  canViewCosts,
}: {
  excluded: ExcludedRow[];
  canViewCosts: boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">
          Not on the buy list · {excluded.length}
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Nothing here is being ordered. This is why each one isn&apos;t.
        </p>
      </div>
      {EXCLUDED_GROUPS.map(({ reason, title, subtitle }) => {
        const groupRows = excluded.filter((r) => r.reason === reason);
        if (groupRows.length === 0) return null;
        // A run that sized these to nothing has no quantity or line total worth
        // a column — 0 and KES 0 down the page is noise, not information.
        const showsQty = QTY_GROUPS.has(reason);
        return (
          <Card key={reason}>
            <CardHeader title={`${title} · ${groupRows.length}`} subtitle={subtitle} />
            <div className="mt-2 w-full overflow-x-auto pb-2">
              <table className={cn("w-full text-sm", showsQty ? "min-w-[560px]" : "min-w-[420px]")}>
                <thead>
                  <tr className="border-b border-edge bg-surface-2">
                    <th scope="col" className={TH}>Product</th>
                    <th scope="col" className={cn(TH, "hidden md:table-cell")}>Supplier</th>
                    <th scope="col" className={TH_NUM}>In stock</th>
                    <th scope="col" className={TH_NUM}>Days left</th>
                    {showsQty && (
                      <>
                        <th scope="col" className={cn(TH_NUM, "hidden md:table-cell")}>Suggested qty</th>
                        <th scope="col" className={TH_NUM}>Line total</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((row) => {
                    const caveat = coveredCaveat(row);
                    return (
                      <tr key={row.predictionId} className="border-b border-edge">
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-ink">{row.title}</span>
                            {row.abc && <Badge tone="neutral">{row.abc}</Badge>}
                            <TrustChips row={row} />
                          </div>
                          <div className="mt-0.5 font-mono text-xs text-ink-muted">{row.sku}</div>
                          {reason === "unplannable" && PLANNABLE_NOTES[row.plannable] && (
                            <p className="mt-1 text-xs text-warning">{PLANNABLE_NOTES[row.plannable]}</p>
                          )}
                          {caveat && (
                            <p className="mt-1 max-w-prose text-xs text-ink-secondary">{caveat}</p>
                          )}
                          {/* Closed by default: the heading answers the common case,
                              and a page of open prose is as unreadable as silence.
                              Native disclosure, so it needs no state on a read-only
                              section and still opens without JavaScript. */}
                          <details className="mt-1.5">
                            <summary
                              aria-label={`Show the numbers for ${row.title}`}
                              className="cursor-pointer list-none text-xs font-medium text-accent-ink hover:underline"
                            >
                              Show the numbers
                            </summary>
                            <div className="mt-2 max-w-prose">
                              <WhyPanel row={row} />
                            </div>
                          </details>
                        </td>
                        <td className={cn(TD, "hidden md:table-cell")}>{row.supplierName ?? "—"}</td>
                        <td className={TD_NUM}>{row.onHandUnits}</td>
                        <td className={TD_NUM}>
                          {row.onHandUnits <= 0 || row.daysUntilStockout == null
                            ? "—"
                            : `${row.daysUntilStockout}d`}
                        </td>
                        {showsQty && (
                          <>
                            <td className={cn(TD_NUM, "hidden md:table-cell")}>{row.recommendedQty}</td>
                            <td className={TD_NUM}>
                              <CostValue amount={row.lineTotalKes} canViewCosts={canViewCosts} />
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function BuyChecklist({
  buyList,
  canViewCosts,
  canOverride,
  urgentOnly,
  onUrgentOnlyChange,
  whatIfActive,
  onWhatIfChange,
}: {
  /** Already scoped and narrowed by the parent — this is the list on screen, and
   *  the same one the decision header above it totals. */
  buyList: BuyList;
  canViewCosts: boolean;
  canOverride: boolean;
  /** The urgency lens. Owned above so the header sees it too; the button here
   *  only reports the click. */
  urgentOnly: boolean;
  onUrgentOnlyChange: (next: boolean) => void;
  /** Whether a what-if re-size is applied. The re-sized list itself goes up to
   *  the parent, which filters it and hands it back as `buyList`. */
  whatIfActive: boolean;
  onWhatIfChange: (next: BuyList | null) => void;
}) {
  const currency = useCurrency();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // What-if lenses: the re-sized list the server returns is handed UP, because
  // the decision header has to total the same rows this renders. Both lenses
  // share one slot and re-size on the one engine server-side; overrides and
  // ordering still act on the underlying plan, so this stays an exploration,
  // not a second commit path. The two actions each carry a single dimension, so
  // engaging one lens returns the other to neutral — the on-screen steppers
  // always reflect the applied view. "Reset to plan" clears both.
  const [sort, setSort] = useState<SortKey>("plan");
  const [coverDays, setCoverDays] = useState(DEFAULT_COVER_DAYS);
  const [upliftPct, setUpliftPct] = useState(DEFAULT_WHATIF_UPLIFT);
  const [resizeError, setResizeError] = useState<string | null>(null);
  const [resizing, startResize] = useTransition();

  const view = buyList;
  const rows = view.rows;

  // What the tiers actually render. The scope and urgency lenses have already
  // been applied by the parent, so all that is left here is the chosen order —
  // and every count on this screen therefore describes the same set. Ticking is
  // unaffected: a row ticked before the filter narrowed stays ticked and stays
  // in the total.
  const shownRows = useMemo(() => sortRows(rows, sort), [rows, sort]);

  const sortOptions = SORTS.filter((s) => !s.needsCosts || canViewCosts);

  function applyCover(days: number) {
    const clamped = clampCoverDays(days);
    setCoverDays(clamped);
    setUpliftPct(DEFAULT_WHATIF_UPLIFT); // cover lens takes over from any sales push
    startResize(async () => {
      const result = await planCoverHorizon({ coverDays: clamped });
      if (!result.ok) {
        setResizeError(result.error);
        return;
      }
      setResizeError(null);
      onWhatIfChange(result.data);
    });
  }

  function applyUplift(pct: number) {
    const clamped = Math.max(UPLIFT_MIN, Math.min(UPLIFT_MAX, pct));
    setUpliftPct(clamped);
    setCoverDays(DEFAULT_COVER_DAYS); // sales-push lens takes over from any cover
    // Stepping back to no push is the same as showing the plan.
    if (clamped <= 0) {
      resetToPlan();
      return;
    }
    startResize(async () => {
      const result = await planSalesTarget({ upliftPct: clamped });
      if (!result.ok) {
        setResizeError(result.error);
        return;
      }
      setResizeError(null);
      onWhatIfChange(result.data);
    });
  }

  function resetToPlan() {
    onWhatIfChange(null);
    setResizeError(null);
    setCoverDays(DEFAULT_COVER_DAYS);
    setUpliftPct(DEFAULT_WHATIF_UPLIFT);
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
    { header: "En route", cell: (r) => r.onOrderUnits },
    { header: "Run/day", cell: (r) => r.runRatePerDay },
    { header: "Days left", cell: (r) => r.daysUntilStockout },
    { header: "Order by", cell: (r) => dayLabel(r.orderByDate) },
    { header: "Order qty", cell: (r) => r.recommendedQty },
    // Revenue is a sales figure — exported for every role.
    { header: `Revenue 30d (${currency})`, cell: (r) => r.revenue30dKes },
    // Money-blind members export what they see: no cost columns.
    ...(canViewCosts
      ? ([
          { header: `Unit cost (${currency})`, cell: (r) => r.unitCostKes },
          { header: `Line total (${currency})`, cell: (r) => r.lineTotalKes },
        ] satisfies ExportColumn<BuyListRow>[])
      : []),
    // Not money, so these ship for every role — a printed list taken to a
    // supplier should carry the same honesty word as the screen it came from.
    { header: "Confidence", cell: (r) => (r.confidence ? CONFIDENCE_COPY[r.confidence].chip : "") },
    { header: "Sizing", cell: (r) => (r.explain ? (SIZING_RULE_COPY[r.explain.method] ?? "") : "") },
    { header: "Why", cell: (r) => r.reasoning },
  ];

  const runDay = dayLabel(view.runDate);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* "full list" was true only while nothing was filtered. The list on
            screen is now whatever the scope and urgency lenses left, and this
            sentence describes that. */}
        <p className="text-sm text-ink-muted">
          {shownRows.length} products to order · they cost{" "}
          <CostValue amount={view.totalCostKes} canViewCosts={canViewCosts} />
          {view.excluded.length > 0 && <> · {view.excluded.length} held back</>}
        </p>
        <ExportBar
          rows={shownRows}
          columns={exportColumns}
          filename="buy-list"
          /* The document describes the rows it contains. Building the subtitle
             from the unfiltered plan headed a twelve-line PDF "25 products",
             so the printed page contradicted itself and a supplier reading it
             could not tell which count was real. */
          document={{
            title: "Restock buy list",
            subtitle: `Forecast run ${runDay} · ${shownRows.length} products`,
            footNote: canViewCosts
              ? `Listed total: ${formatMoney(view.totalCostKes ?? 0, currency)}`
              : undefined,
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-muted">
          <span className="font-medium text-ink">{picked.size}</span> of {shownRows.length} ticked ·{" "}
          <CostValue amount={pickedTotalKes} canViewCosts={canViewCosts} />
        </span>
        <button
          type="button"
          onClick={() => onUrgentOnlyChange(!urgentOnly)}
          aria-pressed={urgentOnly}
          title="Show only the lines that are critical or close to it"
          className={cn(
            "rounded-sm border px-2.5 py-1.5 text-2xs font-medium transition-colors",
            urgentOnly
              ? "border-accent-200 bg-accent-soft text-accent-ink"
              : "border-edge bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink"
          )}
        >
          Urgent only
        </button>
        <label className="flex items-center gap-1.5 text-2xs text-ink-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort the buy list"
            className="rounded-sm border border-edge bg-surface px-2 py-1.5 text-2xs text-ink transition-colors hover:bg-surface-2 focus:border-accent-500 focus:ring-4 focus:ring-accent-100 focus:outline-none"
          >
            {sortOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={shownRows.length === 0}
            onClick={() => setPicked(new Set(shownRows.map((r) => r.predictionId)))}
          >
            Select all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={picked.size === 0}
            onClick={() => setPicked(new Set())}
          >
            Deselect
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-edge bg-surface-2/40 px-4 py-3">
        <Stepper
          label="Size to cover"
          value={`${coverDays} days`}
          onDecrement={() => applyCover(coverDays - COVER_STEP)}
          onIncrement={() => applyCover(coverDays + COVER_STEP)}
          decrementLabel="Fewer days of cover"
          incrementLabel="More days of cover"
          canDecrement={coverDays > COVER_MIN}
          canIncrement={coverDays < COVER_MAX}
          busy={resizing}
          edit={{
            value: coverDays,
            min: COVER_MIN,
            max: COVER_MAX,
            unit: "days",
            ariaLabel: "Days of cover to size to",
            onCommit: applyCover,
          }}
        />
        <Stepper
          label="Size for a sales push"
          value={`+${upliftPct}%`}
          valueClassName="w-16"
          onDecrement={() => applyUplift(upliftPct - UPLIFT_STEP)}
          onIncrement={() => applyUplift(upliftPct + UPLIFT_STEP)}
          decrementLabel="Smaller sales push"
          incrementLabel="Bigger sales push"
          canDecrement={upliftPct > UPLIFT_MIN}
          canIncrement={upliftPct < UPLIFT_MAX}
          busy={resizing}
          edit={{
            value: upliftPct,
            min: UPLIFT_MIN,
            max: UPLIFT_MAX,
            unit: "%",
            ariaLabel: "Sales push percentage",
            onCommit: applyUplift,
          }}
        />
        {whatIfActive && (
          <Badge tone="warning" className="font-sans">
            what-if
          </Badge>
        )}
        <p className="max-w-prose text-xs text-ink-muted">
          Two ways to explore, never below an item&apos;s lead time: size every line
          to {coverDays} days of cover, or size for a +{upliftPct}% sales push
          (what-if) that lifts expected demand for a promotion or season. For
          calibrated or min/max items a re-size can differ from the nightly
          recommendation. Overrides and ordering still use the plan.
        </p>
        <div className="ml-auto flex items-center gap-3">
          {resizeError && <span className="text-xs text-negative">{resizeError}</span>}
          {whatIfActive && (
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
        const tierRows = shownRows.filter((r) => r.tier === tier);
        if (tierRows.length === 0) return null;
        return (
          <Card key={tier}>
            <CardHeader title={`${title} · ${tierRows.length}`} subtitle={subtitle} />
            <div className="mt-2 w-full overflow-x-auto pb-2">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-edge bg-surface-2">
                    <th scope="col" className="w-10 px-5 py-3" aria-label="Tick to order" />
                    <th scope="col" className={TH}>Product</th>
                    <th scope="col" className={cn(TH, "hidden md:table-cell")}>Supplier</th>
                    {/* Stock on its way, however it was set in motion — an
                        en-route transfer or the store's own incoming count, not
                        only a purchase order this shop raised. */}
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>En route</th>
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>MOQ</th>
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>Lead</th>
                    <th scope="col" className={cn(TH_NUM, "hidden md:table-cell")}>Run/day</th>
                    <th scope="col" className={TH_NUM}>Days left</th>
                    <th scope="col" className={cn(TH, "hidden md:table-cell")}>Order by</th>
                    <th scope="col" className={TH_NUM}>Qty</th>
                    <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>Rev · 30d ({currency})</th>
                    <th scope="col" className={TH_NUM}>Line total</th>
                    <th scope="col" className="w-10 px-5 py-3" aria-label="Show reasoning" />
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
                          <td className="px-5 py-3">
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
                          <td className="px-5 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-ink">{row.title}</span>
                              {row.abc && <Badge tone="neutral">{row.abc}</Badge>}
                              <TrustChips row={row} />
                            </div>
                            <div className="mt-0.5 font-mono text-xs text-ink-muted">
                              {row.sku}
                              {row.plannable !== "ok" && (
                                <Badge tone="warning" className="ml-2 font-sans">
                                  Check cost
                                </Badge>
                              )}
                              {row.doubleOrderWarn && (
                                <Badge tone="warning" className="ml-2 font-sans">
                                  also on a draft PO
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
                            {row.onHandUnits <= 0 || row.daysUntilStockout == null
                              ? "—"
                              : `${row.daysUntilStockout}d`}
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
                              {row.leadFloored && <LeadFlooredNote leadDays={row.leadDays} />}
                            </div>
                          </td>
                          <td className={cn(TD_NUM, "hidden lg:table-cell")}>
                            {/* Revenue is a sales figure — shown to every role as a plain
                                amount (unit in the header), like the Stock catalogue. */}
                            {row.revenue30dKes > 0 ? formatNumber(row.revenue30dKes) : "—"}
                          </td>
                          <td className={TD_NUM}>
                            <CostValue amount={row.lineTotalKes} canViewCosts={canViewCosts} />
                          </td>
                          <td className="px-5 py-3">
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
                            <td colSpan={13} className="px-5 pt-0 pb-4">
                              <WhyPanel row={row} />
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

      {view.excluded.length > 0 && (
        <ExcludedSection excluded={view.excluded} canViewCosts={canViewCosts} />
      )}

      {(picked.size > 0 || notice) && (
        <ActionBar>
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
        </ActionBar>
      )}
    </div>
  );
}
