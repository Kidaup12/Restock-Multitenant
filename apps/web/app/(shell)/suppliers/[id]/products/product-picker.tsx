"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PickerProduct } from "@/lib/data/suppliers";
import { assignProductsToSupplierAction, setProductLeadTimeAction } from "../../actions";

/**
 * Tick products, assign them to this supplier in one write.
 *
 * Products already with this supplier start ticked, so the list reads as "here
 * is what they supply" and un-ticking is not offered as a way to unassign —
 * that would be a second, quieter mutation hiding inside a save. Moving a
 * product off a supplier means ticking it under a different one, which is the
 * only way it can end up in exactly one place.
 */
export function ProductPicker({
  supplierId,
  supplierName,
  products,
  truncated,
  search,
}: {
  supplierId: string;
  supplierName: string;
  products: PickerProduct[];
  truncated: boolean;
  search: string;
}) {
  const alreadyMine = useMemo(
    () => new Set(products.filter((p) => p.supplierId === supplierId).map((p) => p.id)),
    [products, supplierId],
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  const router = useRouter();

  const toAssign = useMemo(() => [...picked].filter((id) => !alreadyMine.has(id)), [picked, alreadyMine]);
  const movingFromOther = useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p]));
    return toAssign.filter((id) => byId.get(id)?.supplierId != null).length;
  }, [toAssign, products]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    setNote(null);
    startTransition(async () => {
      const result = await assignProductsToSupplierAction({ supplierId, productIds: toAssign });
      if (result.ok) {
        setPicked(new Set());
        setNote({ tone: "positive", text: result.message ?? "Saved." });
        router.refresh();
      } else {
        setNote({ tone: "negative", text: result.error });
      }
    });
  }

  function saveLeadTime(productId: string, raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value != null && !Number.isFinite(value)) return;
    startTransition(async () => {
      const result = await setProductLeadTimeAction({ productId, leadTimeDays: value });
      if (result.ok) router.refresh();
      else setNote({ tone: "negative", text: result.error });
    });
  }

  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={search}
          placeholder="Search by product, SKU or brand"
          className="peer w-72 rounded-md border border-edge bg-surface px-3 py-2 text-sm text-ink"
          aria-label="Search products"
        />
        <Button
          size="sm"
          variant="ghost"
          type="submit"
          className="peer-placeholder-shown:hidden"
        >
          Search
        </Button>
        {search && (
          <a href="?" className="text-xs text-ink-muted hover:text-ink">
            Clear
          </a>
        )}
      </form>

      {truncated && (
        <p className="text-xs text-ink-muted">
          Showing the first results only — search to narrow this down.
        </p>
      )}

      {products.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Try a different product name, SKU or brand."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>Supplier today</TableHead>
                <TableHead numeric>Lead time (days)</TableHead>
              </TableHeader>
              <TableBody>
                {products.map((p) => {
                  const mine = p.supplierId === supplierId;
                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 size-4 accent-(--accent)"
                            checked={mine || picked.has(p.id)}
                            disabled={mine}
                            onChange={() => toggle(p.id)}
                            aria-label={`Buy ${p.title} from ${supplierName}`}
                          />
                          <span>
                            <span className="block text-ink">{p.title}</span>
                            {p.sku && (
                              <span className="block font-mono text-xs text-ink-muted">{p.sku}</span>
                            )}
                          </span>
                        </label>
                      </TableCell>
                      <TableCell>{p.vendor ?? "—"}</TableCell>
                      <TableCell>
                        {mine ? (
                          <span className="text-ink-muted">Already theirs</span>
                        ) : p.supplierName ? (
                          <span className="text-warning">{p.supplierName}</span>
                        ) : (
                          <span className="text-ink-muted">None</span>
                        )}
                      </TableCell>
                      <TableCell numeric>
                        {/* The one figure that decides when to reorder, editable
                            without inventing a supplier for it. Blank falls back
                            to whoever supplies the product. */}
                        <input
                          type="number"
                          min={0}
                          max={365}
                          defaultValue={p.leadTimeDays ?? ""}
                          placeholder="supplier's"
                          disabled={pending}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            const current = p.leadTimeDays == null ? "" : String(p.leadTimeDays);
                            if (next !== current) saveLeadTime(p.id, next);
                          }}
                          className="w-24 rounded-md border border-edge bg-surface px-2 py-1 text-right text-sm text-ink"
                          aria-label={`Lead time for ${p.title}`}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {note && (
        <p
          className={
            note.tone === "positive"
              ? "text-sm font-medium text-positive"
              : "text-sm font-medium text-negative"
          }
        >
          {note.text}
        </p>
      )}

      {toAssign.length > 0 && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 shadow-pop">
          <span className="text-sm text-ink">
            {toAssign.length} to add
            {movingFromOther > 0 && (
              <span className="text-ink-muted">
                {" "}
                · {movingFromOther} currently with someone else
              </span>
            )}
          </span>
          <Button size="sm" onClick={save} loading={pending} className="ml-auto">
            Assign to {supplierName}
          </Button>
        </div>
      )}
    </div>
  );
}
