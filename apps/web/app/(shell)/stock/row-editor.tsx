"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CostValue } from "@/components/ui/cost-value";
import { formatMovePct, VERDICT_LABELS, VERDICT_TONES } from "@/lib/cost";
import type { CatalogueRow } from "@/lib/data/stock";
import {
  assignCategoryAction,
  clearCostPinAction,
  setManualCostAction,
  setNotForSaleAction,
  type CatalogueActionResult,
} from "./actions";

/**
 * The expanding row editor (spec §2 "all editing lives in an expanding row
 * editor"): the manual cost pin (+ release), the not-for-sale toggle, and the
 * category assignment. Fixes are made without leaving the page — each write is a
 * server action; on success the row data is re-fetched.
 */

const SOURCE_LABEL: Record<string, string> = {
  manual: "typed (pinned)",
  qb: "from QuickBooks",
  shopify: "from Shopify",
  missing: "missing",
};

export function RowEditor({
  row,
  categories,
  canViewCosts,
  canManage,
}: {
  row: CatalogueRow;
  categories: string[];
  canViewCosts: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [costInput, setCostInput] = useState("");
  const [category, setCategory] = useState(row.customCategory ?? "");

  function run(action: () => Promise<CatalogueActionResult>) {
    setMsg(null);
    start(async () => {
      const res = await action();
      if (res.ok) {
        setMsg({ tone: "ok", text: res.message ?? "Saved." });
        setCostInput("");
        router.refresh();
      } else {
        setMsg({ tone: "err", text: res.error });
      }
    });
  }

  return (
    <div className="space-y-4 bg-surface-2/40 px-4 py-4">
      {!canManage && (
        <p className="text-sm text-ink-muted">You need settings access to edit this product.</p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {/* ── Cost ─────────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">Cost</div>
          <div className="flex items-center gap-2 text-sm">
            <CostValue amount={row.costKes} canViewCosts={canViewCosts} />
            <span className="text-ink-muted">· {SOURCE_LABEL[row.costSource]}</span>
          </div>
          {row.costMovedPct != null && (
            <Badge tone="warning">Cost moved {formatMovePct(row.costMovedPct)}</Badge>
          )}
          {canManage && canViewCosts && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="Type a cost"
                  value={costInput}
                  onChange={(e) => setCostInput(e.target.value)}
                  className="h-9 max-w-40"
                />
                <Button
                  size="sm"
                  loading={pending}
                  disabled={!costInput}
                  onClick={() => run(() => setManualCostAction({ productId: row.productId, costKes: Number(costInput) }))}
                >
                  Pin cost
                </Button>
              </div>
              {row.costSource === "manual" && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() => run(() => clearCostPinAction({ productId: row.productId }))}
                >
                  Use synced cost
                </Button>
              )}
              <p className="text-xs text-ink-faint">A typed cost pins — the sync won&apos;t overwrite it.</p>
            </div>
          )}
          {!canViewCosts && <p className="text-xs text-ink-faint">Costs are hidden for your role.</p>}
        </div>

        {/* ── Category ─────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">Category</div>
          {canManage ? (
            <div className="space-y-2">
              <Input
                list="catalogue-categories"
                placeholder="Assign or + new category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9"
              />
              <datalist id="catalogue-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <Button
                size="sm"
                loading={pending}
                onClick={() =>
                  run(() => assignCategoryAction({ productId: row.productId, category: category.trim() || null }))
                }
              >
                Save category
              </Button>
            </div>
          ) : (
            <div className="text-sm text-ink">{row.customCategory ?? "Uncategorised"}</div>
          )}
        </div>

        {/* ── Not for sale ─────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">Availability</div>
          <div className="flex items-center gap-2 text-sm">
            {row.verdict ? (
              <Badge tone={VERDICT_TONES[row.verdict]}>{VERDICT_LABELS[row.verdict]}</Badge>
            ) : (
              <Badge tone="neutral">Not for sale</Badge>
            )}
          </div>
          {canManage && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={row.notForSale}
                disabled={pending}
                onChange={(e) => run(() => setNotForSaleAction({ productId: row.productId, notForSale: e.target.checked }))}
                className="size-4 accent-[var(--accent)]"
              />
              Not for sale (tester / display / damaged)
            </label>
          )}
          <p className="text-xs text-ink-faint">Not-for-sale stock leaves sellable cover and the buy list.</p>
        </div>
      </div>

      {msg && (
        <p className={msg.tone === "ok" ? "text-xs text-positive" : "text-xs text-negative"}>{msg.text}</p>
      )}
    </div>
  );
}
