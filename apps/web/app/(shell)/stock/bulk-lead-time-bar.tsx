"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setLeadTimeForProductsAction } from "./actions";
import type { CatalogueQuery } from "@/lib/catalogue";

/**
 * What you can do with a selection. Lead time first, because it is the field
 * the forecast needs and the one nothing could write in bulk: an order-by date
 * computed with no lead time assumes stock arrives the moment it is ordered.
 *
 * The bar sticks to the bottom rather than sitting above the table, so a reader
 * who ticked rows on screen and scrolled looking for more can still act without
 * scrolling back — the same shape the supplier product picker uses.
 */
export function BulkLeadTimeBar({
  count,
  /** Set when the reader chose "all N matching": the server re-derives the rows
   *  from these filters, because the browser only ever held one page of them. */
  query,
  productIds,
  onApplied,
  onDeselect,
}: {
  count: number;
  query: CatalogueQuery | null;
  productIds: string[];
  onApplied: () => void;
  onDeselect: () => void;
}) {
  const [days, setDays] = useState("");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  function apply(leadTimeDays: number | null) {
    setNote(null);
    startTransition(async () => {
      const result = await setLeadTimeForProductsAction(
        query ? { leadTimeDays, query } : { leadTimeDays, productIds },
      );
      if (result.ok) {
        setNote({ tone: "ok", text: result.message ?? "Done." });
        setDays("");
        onApplied();
      } else {
        setNote({ tone: "bad", text: result.error });
      }
    });
  }

  const typed = days.trim();
  const parsed = typed === "" ? null : Number(typed);
  const valid = parsed != null && Number.isFinite(parsed) && parsed >= 0 && parsed <= 365;

  return (
    <div className="sticky bottom-4 z-10 mx-4 flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 shadow-pop">
      <span className="text-sm font-medium text-ink">
        {count} {count === 1 ? "product" : "products"} selected
      </span>

      <span className="flex items-center gap-2">
        <label htmlFor="bulk-lead-days" className="text-sm text-ink-muted">
          Lead time
        </label>
        <input
          id="bulk-lead-days"
          type="number"
          min={0}
          max={365}
          inputMode="numeric"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && apply(parsed)}
          placeholder="days"
          className="h-9 w-24 rounded-md border border-edge bg-surface px-3 text-sm text-ink"
        />
        <Button size="sm" onClick={() => apply(parsed)} loading={pending} disabled={!valid || pending}>
          Apply
        </Button>
      </span>

      {/* Clearing is its own control rather than an empty box, so "I typed
          nothing yet" can never be mistaken for "remove the lead time". */}
      <button
        type="button"
        onClick={() => apply(null)}
        disabled={pending}
        className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
      >
        Clear lead time
      </button>

      <button
        type="button"
        onClick={onDeselect}
        disabled={pending}
        className="ml-auto text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
      >
        Deselect
      </button>

      {note && (
        <span
          role="status"
          className={note.tone === "ok" ? "w-full text-sm text-positive" : "w-full text-sm text-negative"}
        >
          {note.text}
        </span>
      )}
    </div>
  );
}
