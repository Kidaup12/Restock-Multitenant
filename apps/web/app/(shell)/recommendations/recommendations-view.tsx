"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AbcBadge } from "@/components/ui/abc-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { MultiPicker } from "@/components/ui/multi-picker";
import { useCurrency } from "@/components/currency-provider";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/money";
import type { RecommendationList, RecommendationRow } from "@/lib/data/recommendations";
import { ACTION_LABELS, type RecommendationAction } from "@/lib/recommendations/labels";
import { closeRecommendation, planOffer, skipReorder } from "./actions";

const ORDER: RecommendationAction[] = ["discount", "bundle", "stop_reorder", "clear"];

const ACTION_HELP: Record<RecommendationAction, string> = {
  discount:
    "Not selling, or far more on the shelf than you'll sell in three months. The suggested discount grows with how long it has sat, and never takes the price below cost.",
  bundle:
    "The margin is too thin to discount, so pair it with a best seller from the same category — a bundle price or a free add-on.",
  stop_reorder: "The current plan would buy more of something that isn't selling. Skipping takes it off the buy list until you change it.",
  clear: "Hasn't sold for a long time and can't take a discount. Ask the supplier about a return, or clear it out.",
};

const TONE: Record<RecommendationAction, "warning" | "accent" | "negative" | "neutral"> = {
  discount: "warning",
  bundle: "accent",
  stop_reorder: "neutral",
  clear: "negative",
};

export function RecommendationsView({
  list,
  canViewCosts,
  canOrder,
  canPlanOffers,
}: {
  list: RecommendationList;
  canViewCosts: boolean;
  canOrder: boolean;
  canPlanOffers: boolean;
}) {
  const currency = useCurrency();
  const [action, setAction] = useState<RecommendationAction | null>(null);
  const [suppliers, setSuppliers] = useState<string[]>([]);

  const supplierOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of list.rows) {
      const name = r.supplierName ?? "No supplier";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => a.label.localeCompare(b.label));
  }, [list.rows]);

  const shown = list.rows.filter(
    (r) => (!action || r.action === action) && (suppliers.length === 0 || suppliers.includes(r.supplierName ?? "No supplier"))
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Summary label="Products to act on" value={String(new Set(list.rows.map((r) => r.productId)).size)} />
        <Summary
          label="Cash tied up"
          help="What the idle stock cost you to buy — the money a discount, bundle or return would free. Skipped reorders are not counted here."
          value={list.totalCashKes == null ? "—" : formatMoney(list.totalCashKes, currency, { compact: true })}
        />
        <Summary
          label="Reorders to skip"
          value={String(list.counts.stop_reorder)}
          help="Products the plan would buy more of, even though they aren't selling."
        />
      </div>

      <section aria-label="Filter recommendations" className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-edge bg-surface p-4 shadow-card">
        <div className="space-y-1.5">
          <div className="text-xs font-semibold tracking-wide text-ink-muted uppercase">What to do</div>
          <div className="flex flex-wrap gap-1.5">
            <Chip on={action === null} onClick={() => setAction(null)} count={list.rows.length}>
              All
            </Chip>
            {ORDER.filter((a) => list.counts[a] > 0).map((a) => (
              <Chip key={a} on={action === a} onClick={() => setAction(action === a ? null : a)} count={list.counts[a]}>
                {ACTION_LABELS[a]}
              </Chip>
            ))}
          </div>
        </div>
        {supplierOptions.length > 1 && (
          <div className="w-full space-y-1.5 sm:w-64">
            <div className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Supplier</div>
            <MultiPicker
              label="Supplier"
              allLabel="All suppliers"
              searchPlaceholder="Search suppliers…"
              options={supplierOptions}
              selected={suppliers}
              onChange={setSuppliers}
            />
          </div>
        )}
      </section>

      <ul className="space-y-3">
        {shown.map((row) => (
          <RecommendationCard
            key={row.id}
            row={row}
            currency={currency}
            canViewCosts={canViewCosts}
            canOrder={canOrder}
            canPlanOffers={canPlanOffers}
          />
        ))}
        {shown.length === 0 && <li className="text-sm text-ink-muted">Nothing matches these filters.</li>}
      </ul>
    </div>
  );
}

function Summary({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-surface p-4 shadow-card">
      <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        {label}
        {help && <HelpTip label={`What is ${label.toLowerCase()}?`}>{help}</HelpTip>}
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function Chip({ on, onClick, count, children }: { on: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors",
        on
          ? "border-accent-500 bg-accent-soft font-medium text-accent-ink ring-1 ring-accent-500"
          : "border-edge-strong bg-surface text-ink hover:border-accent-500 hover:bg-surface-2"
      )}
    >
      {children}
      <span className="rounded-full bg-surface-2 px-1.5 font-mono text-xs tabular-nums text-ink-muted">{count}</span>
    </button>
  );
}

function RecommendationCard({
  row,
  currency,
  canViewCosts,
  canOrder,
  canPlanOffers,
}: {
  row: RecommendationRow;
  currency: string;
  canViewCosts: boolean;
  canOrder: boolean;
  canPlanOffers: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
    setNote(null);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setNote({ ok: true, text: done });
        router.refresh();
      } else setNote({ ok: false, text: res.error });
    });
  }

  return (
    <li className="rounded-lg border border-edge bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[row.action]}>{ACTION_LABELS[row.action]}</Badge>
            <HelpTip label={`Why ${ACTION_LABELS[row.action].toLowerCase()}?`}>{ACTION_HELP[row.action]}</HelpTip>
            <AbcBadge value={row.abc} />
          </div>
          <Link href={`/products/${row.productId}`} className="block font-semibold text-ink underline-offset-2 hover:underline">
            {row.title}
          </Link>
          <div className="text-xs text-ink-muted">
            {[row.sku, row.supplierName, row.category].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="font-mono tabular-nums text-ink">
            {row.idleUnits} idle <span className="text-ink-muted">of {Math.round(row.onHand)}</span>
          </div>
          {canViewCosts && row.cashKes != null && row.action !== "stop_reorder" && (
            <div className="font-mono text-xs tabular-nums text-ink-muted">{formatMoney(row.cashKes, currency)} at cost</div>
          )}
        </div>
      </div>

      <p className="mt-3 text-sm text-ink-secondary">{row.reason}</p>
      {row.idea && (
        <p className="mt-1.5 text-sm text-ink-muted">
          <span className="font-medium text-ink">Offer idea:</span> {row.idea}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {row.action === "discount" && canPlanOffers && (
          <Button size="sm" loading={pending} onClick={() => run(() => planOffer({ id: row.id }), "Offer planned for the next two weeks.")}>
            Plan {String(row.payload.pct ?? "")}% offer
          </Button>
        )}
        {row.action === "stop_reorder" && canOrder && (
          <Button size="sm" loading={pending} onClick={() => run(() => skipReorder({ id: row.id }), "Taken off the buy list.")}>
            Skip reorder
          </Button>
        )}
        {canOrder && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => closeRecommendation({ id: row.id, outcome: "done" }), "Marked done.")}
            >
              Done
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => closeRecommendation({ id: row.id, outcome: "dismissed" }), "Dismissed for 90 days.")}
            >
              Dismiss
            </Button>
          </>
        )}
        {note && <span role="status" className={cn("text-sm", note.ok ? "text-positive" : "text-negative")}>{note.text}</span>}
        {row.aiWorded && <span className="ml-auto text-2xs text-ink-faint">Wording by AI · numbers from your data</span>}
      </div>
    </li>
  );
}
