"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OrderQueueGroup } from "@/lib/data/orders";
import { createPoAction } from "./actions";
import { SupplierScoreBadges } from "./supplier-score-badges";

/**
 * One supplier's slice of the order queue: pick lines, see the running total,
 * turn the selection into a purchase order. Everything is re-validated
 * server-side — the checkboxes are a convenience, not the enforcement.
 */
export function QueueGroup({
  group,
  canViewCosts = true,
}: {
  group: OrderQueueGroup;
  canViewCosts?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(group.lines.map((l) => l.orderId))
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allSelected = selected.size === group.lines.length;
  const selection = useMemo(
    () => group.lines.filter((l) => selected.has(l.orderId)),
    [group.lines, selected]
  );
  const selectedUnits = selection.reduce((s, l) => s + l.qty, 0);
  // lineCostKes is null for a money-blind member; the running total is only
  // shown when canViewCosts, so a redacted line contributes nothing here.
  const selectedCost = selection.reduce((s, l) => s + (l.lineCostKes ?? 0), 0);

  const toggle = (orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const create = () => {
    setError(null);
    startTransition(async () => {
      const result = await createPoAction({ orderIds: selection.map((l) => l.orderId) });
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <Card>
      <CardHeader
        title={group.supplierName ?? "No supplier assigned"}
        subtitle={`${group.lines.length} product${group.lines.length === 1 ? "" : "s"} queued${
          group.moq != null && group.moq > 1 ? ` · MOQ ${group.moq}` : ""
        }${group.leadTimeAvgDays != null ? ` · lead ${group.leadTimeAvgDays}d` : ""}`}
        action={
          <div className="flex flex-col items-end gap-2">
            <SupplierScoreBadges score={group.score} />
            {group.supplierId ? (
              <Button
                size="sm"
                onClick={create}
                loading={pending}
                disabled={selection.length === 0}
              >
                Create PO · {selectedUnits} units
                {canViewCosts && (
                  <>
                    {" · "}
                    <CostValue amount={selectedCost} compact />
                  </>
                )}
              </Button>
            ) : (
              <span className="text-xs text-ink-muted">
                Assign a supplier to order these
              </span>
            )}
          </div>
        }
      />
      {error && (
        <p className="px-5 pt-2 text-sm text-negative" role="alert">
          {error}
        </p>
      )}
      <div className="mt-2 pb-2">
        <Table>
          <TableHeader>
            <TableHead className="w-10">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(group.lines.map((l) => l.orderId))
                  )
                }
                className="size-4 accent-(--accent)"
              />
            </TableHead>
            <TableHead>Product</TableHead>
            <TableHead numeric>In stock</TableHead>
            <TableHead numeric>Order qty</TableHead>
            <TableHead numeric>Unit cost</TableHead>
            <TableHead numeric>Line cost</TableHead>
          </TableHeader>
          <TableBody>
            {group.lines.map((line) => (
              <TableRow key={line.orderId}>
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={`Select ${line.title}`}
                    checked={selected.has(line.orderId)}
                    onChange={() => toggle(line.orderId)}
                    className="size-4 accent-(--accent)"
                  />
                </TableCell>
                <TableCell className="font-medium text-ink">
                  {line.title}
                  <span className="ml-2 font-mono text-xs text-ink-faint">{line.sku}</span>
                </TableCell>
                <TableCell numeric>{line.onHandUnits}</TableCell>
                <TableCell numeric>{line.qty}</TableCell>
                <TableCell numeric>
                  <CostValue amount={line.unitCostKes} canViewCosts={canViewCosts} />
                </TableCell>
                <TableCell numeric>
                  <CostValue amount={line.lineCostKes} canViewCosts={canViewCosts} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
