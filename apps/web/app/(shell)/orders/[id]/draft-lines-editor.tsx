"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { CostValue } from "@/components/ui/cost-value";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { removePoLineAction, setPoLineQtyAction } from "../actions";

type DraftLine = {
  id: string;
  sku: string;
  title: string;
  quantity: number;
  recommendedQty: number | null;
  unitCostKes: number | null;
  lineTotalKes: number | null;
};

/**
 * A draft order's lines, while they are still the shop's to change.
 *
 * Only rendered for a draft. Once the order is sent the supplier holds those
 * numbers, and the page falls back to the read-only table — changing a quantity
 * afterwards would leave our record disagreeing with the document the supplier
 * is picking from.
 *
 * The quantity commits on Enter, on an explicit Save, or on leaving the field —
 * never on every keystroke, because each save re-prices the whole order and
 * firing that per character would write a string of totals nobody asked for.
 * An edited field grows a Save button rather than relying on blur alone: a
 * value that only persists as a side effect of clicking away gives the reader
 * no sign that it saved, and nothing to press if they want it to.
 */
export function DraftLinesEditor({
  poId,
  lines,
  canViewCosts,
}: {
  poId: string;
  lines: DraftLine[];
  canViewCosts: boolean;
}) {
  const { confirm, dialog } = useConfirm();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** Forget an uncommitted edit for one line. */
  const clearDraft = (id: string) =>
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([key]) => key !== id)));

  const commit = (line: DraftLine) => {
    const raw = drafts[line.id];
    if (raw === undefined) return;
    const next = Number.parseInt(raw, 10);
    // Nothing to do, and nothing to complain about: leaving the field as it was
    // is not an edit.
    if (!Number.isInteger(next) || next === line.quantity) {
      clearDraft(line.id);
      return;
    }
    setError(null);
    setBusyLine(line.id);
    startTransition(async () => {
      const result = await setPoLineQtyAction({ poId, lineId: line.id, quantity: next });
      if (!result.ok) setError(result.error);
      setBusyLine(null);
      clearDraft(line.id);
    });
  };

  const remove = async (line: DraftLine) => {
    const ok = await confirm({
      title: `Remove ${line.title}?`,
      body: "It goes back on the buy list, ready to be ordered again.",
      confirmLabel: "Remove line",
      cancelLabel: "Keep it",
    });
    if (!ok) return;
    setError(null);
    setBusyLine(line.id);
    startTransition(async () => {
      const result = await removePoLineAction({ poId, lineId: line.id });
      if (!result.ok) setError(result.error);
      setBusyLine(null);
    });
  };

  return (
    <div>
      {dialog}
      <Table>
        <TableHeader>
          <TableHead>SKU</TableHead>
          <TableHead>Item</TableHead>
          <TableHead numeric>Qty</TableHead>
          <TableHead numeric>Unit cost</TableHead>
          <TableHead numeric>Total</TableHead>
          <TableHead>
            <span className="sr-only">Remove</span>
          </TableHead>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const draft = drafts[line.id];
            const uncommitted = draft !== undefined && Number.parseInt(draft, 10) !== line.quantity;
            return (
              <TableRow key={line.id}>
                <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                <TableCell>
                  <div className="font-medium text-ink">{line.title}</div>
                  {line.recommendedQty != null && line.recommendedQty !== line.quantity && (
                    // What the model asked for, kept visible once the owner has
                    // moved away from it — otherwise the disagreement is only in
                    // the database.
                    <div className="text-xs text-ink-muted">
                      forecast asked for {line.recommendedQty}
                    </div>
                  )}
                </TableCell>
                <TableCell numeric>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={draft ?? String(line.quantity)}
                    disabled={pending && busyLine === line.id}
                    onChange={(e) => setDrafts((d) => ({ ...d, [line.id]: e.target.value }))}
                    onBlur={() => commit(line)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit(line);
                      }
                      if (e.key === "Escape") {
                        clearDraft(line.id);
                      }
                    }}
                    aria-label={`Quantity for ${line.title}`}
                    className="h-9 w-20 rounded-md border border-edge bg-surface px-2 text-right text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                  {uncommitted && (
                    // An explicit control, not only Enter-or-click-away. A
                    // quantity that saves solely as a side effect of leaving the
                    // field gives no signal that it did, and no way to ask it to.
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1"
                      onClick={() => commit(line)}
                      loading={pending && busyLine === line.id}
                    >
                      Save
                    </Button>
                  )}
                </TableCell>
                <TableCell numeric>
                  <CostValue amount={line.unitCostKes} canViewCosts={canViewCosts} />
                </TableCell>
                <TableCell numeric>
                  <CostValue amount={line.lineTotalKes} canViewCosts={canViewCosts} />
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(line)}
                    disabled={pending || lines.length === 1}
                    // An order with no lines is not an order; cancelling is the
                    // action that says what actually happened.
                    title={lines.length === 1 ? "Cancel the order instead" : undefined}
                  >
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {error && <p className="mt-3 text-sm text-negative">{error}</p>}
    </div>
  );
}
