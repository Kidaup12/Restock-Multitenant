"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrency } from "@/components/currency-provider";
import type { PlannableReason } from "@/lib/data/plan";
import { fixProductCost } from "./actions";

/**
 * Inline "fix the cost" control for a product the plan held back because its
 * cost (or price) is blank or broken. Set the number(s) here and the row folds
 * back into the buy list on the next re-plan — the reference app's
 * "check these costs" fixer, in this repo's design system.
 *
 * The write goes through `fixProductCost`, which is gated server-side on
 * view_costs + approve_orders. This component is only rendered when the caller
 * already holds both (canViewCosts + canOverride), so the affordance never
 * appears where it cannot be used.
 *
 * Which fields it asks for follows the reason: a missing/negative price (or a
 * cost above the price) needs the price too, not just the cost.
 */

const REASON_LABEL: Record<string, string> = {
  "missing-cost": "no cost on file",
  "missing-price": "no price on file",
  "cost-exceeds-price": "cost is above the price",
};

export function CostFixer({
  productId,
  plannable,
  onFixed,
}: {
  productId: string;
  /** Why the row is held back — decides whether a price field is shown. */
  plannable: PlannableReason;
  /** Called after a successful save so the parent can note it / prompt a re-plan. */
  onFixed?: () => void;
}) {
  const currency = useCurrency();
  const needsPrice = plannable === "missing-price" || plannable === "cost-exceeds-price";
  const [editing, setEditing] = useState(false);
  const [cost, setCost] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  if (done) {
    return <span className="text-xs font-medium text-positive">Fixed — re-plan to include it.</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs font-medium text-accent-ink hover:underline"
      >
        Fix {REASON_LABEL[plannable] ? `(${REASON_LABEL[plannable]})` : "cost"}
      </button>
    );
  }

  function save() {
    const costNum = cost.trim() ? Number(cost) : null;
    const priceNum = needsPrice && price.trim() ? Number(price) : null;
    if (costNum == null && priceNum == null) {
      setError("Enter a cost.");
      return;
    }
    startTransition(async () => {
      const result = await fixProductCost({ productId, costKes: costNum, priceKes: priceNum });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditing(false);
      setDone(true);
      onFixed?.();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Input
          size="sm"
          inputMode="decimal"
          value={cost}
          disabled={pending}
          onChange={(e) => {
            setCost(e.target.value.replace(/[^\d.]/g, ""));
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder={`cost ${currency}`}
          aria-label="Unit cost"
          className="w-24 font-mono"
        />
        {needsPrice && (
          <Input
            size="sm"
            inputMode="decimal"
            value={price}
            disabled={pending}
            onChange={(e) => {
              setPrice(e.target.value.replace(/[^\d.]/g, ""));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder={`price ${currency}`}
            aria-label="Selling price"
            className="w-24 font-mono"
          />
        )}
        <Button size="sm" loading={pending} onClick={save}>
          Save
        </Button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          disabled={pending}
          className="text-xs font-medium text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
