"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionBar } from "@/components/ui/action-bar";
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
import {
  assignProductsToSupplierAction,
  setProductLeadTimeAction,
  unassignProductsFromSupplierAction,
} from "../../actions";

/**
 * Tick to assign, untick to remove — one Save writes both in the same pass.
 *
 * The default (no search) list is just this supplier's own products, so
 * ticking/unticking here reads as directly editing "what they supply" rather
 * than adding to an unrelated full catalogue. Searching reveals the rest of
 * the catalogue to pull a product in from nobody (or from someone else) —
 * ticking one of those still only ADDS; moving one already on screen (already
 * ticked, from this supplier) off is what unticking now does.
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
  // Ticked state starts seeded with what's already theirs, so an untick is a
  // real, visible change from the moment someone clicks it — not a disabled
  // box that silently can't move. `products` changes after a save's
  // router.refresh() or a new search, and the ticks must follow that fresh
  // list rather than keep showing what used to be true. Reconciled during
  // render (not an effect) against a key of the incoming product ids, so a
  // stale tick never paints even for one frame.
  const productsKey = products.map((p) => p.id).join(",");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(alreadyMine));
  const [seededFor, setSeededFor] = useState(productsKey);
  if (productsKey !== seededFor) {
    setSeededFor(productsKey);
    setPicked(new Set(alreadyMine));
  }
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  const router = useRouter();

  const toAssign = useMemo(() => [...picked].filter((id) => !alreadyMine.has(id)), [picked, alreadyMine]);
  const toUnassign = useMemo(() => [...alreadyMine].filter((id) => !picked.has(id)), [picked, alreadyMine]);
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
      const [assignResult, unassignResult] = await Promise.all([
        toAssign.length > 0
          ? assignProductsToSupplierAction({ supplierId, productIds: toAssign })
          : Promise.resolve({ ok: true as const }),
        toUnassign.length > 0
          ? unassignProductsFromSupplierAction({ supplierId, productIds: toUnassign })
          : Promise.resolve({ ok: true as const }),
      ]);
      if (!assignResult.ok) {
        setNote({ tone: "negative", text: assignResult.error });
        return;
      }
      if (!unassignResult.ok) {
        setNote({ tone: "negative", text: unassignResult.error });
        return;
      }
      const parts = [
        "message" in assignResult ? assignResult.message : null,
        "message" in unassignResult ? unassignResult.message : null,
      ].filter((m): m is string => Boolean(m));
      setNote({ tone: "positive", text: parts.length > 0 ? parts.join(" ") : "Saved." });
      router.refresh();
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
          placeholder="Search the whole catalogue to add more"
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
          title={search ? "Nothing matches" : "Nothing from this supplier yet"}
          description={
            search
              ? "Try a different product name, SKU or brand."
              : "Search above to find products to add — the whole catalogue is searchable, not just what's already theirs."
          }
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
                            checked={picked.has(p.id)}
                            onChange={() => toggle(p.id)}
                            aria-label={
                              mine
                                ? `Stop buying ${p.title} from ${supplierName}`
                                : `Buy ${p.title} from ${supplierName}`
                            }
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

      {(toAssign.length > 0 || toUnassign.length > 0) && (
        <ActionBar>
          <span className="text-sm text-ink">
            {toAssign.length > 0 && `${toAssign.length} to add`}
            {toAssign.length > 0 && toUnassign.length > 0 && " · "}
            {toUnassign.length > 0 && `${toUnassign.length} to remove`}
            {movingFromOther > 0 && (
              <span className="text-ink-muted">
                {" "}
                · {movingFromOther} currently with someone else
              </span>
            )}
          </span>
          <Button size="sm" onClick={save} loading={pending} className="ml-auto">
            Save changes
          </Button>
        </ActionBar>
      )}
    </div>
  );
}
