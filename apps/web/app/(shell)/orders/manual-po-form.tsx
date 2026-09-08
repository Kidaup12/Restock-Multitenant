"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { Select } from "@/components/ui/select";
import type { ManualPoSupplier } from "@/lib/data/orders";
import { createManualPoAction } from "./actions";

/**
 * Ordering something the forecast never asked for.
 *
 * Collapsed by default. This is the exception — most orders come off the buy
 * list — and an open form above the queue every day would read as the ordinary
 * way to buy, which it is not.
 *
 * Only the chosen supplier's products are listed, because a purchase order is
 * addressed to somebody: a line for a product they do not sell is a document
 * they cannot fill, and the delivery would score against a supplier who never
 * had the order. Reassigning a product is a different job, done on the product.
 */
export function ManualPoForm({
  suppliers,
  canViewCosts,
}: {
  suppliers: ManualPoSupplier[];
  canViewCosts: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;

  const shown = useMemo(() => {
    if (!supplier) return [];
    const q = search.trim().toLowerCase();
    if (!q) return supplier.products;
    return supplier.products.filter(
      (p) => p.title.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
  }, [supplier, search]);

  const items = useMemo(
    () =>
      Object.entries(qtys)
        .map(([productId, raw]) => ({ productId, qty: Number.parseInt(raw, 10) }))
        .filter((i) => Number.isInteger(i.qty) && i.qty > 0),
    [qtys]
  );
  const units = items.reduce((s, i) => s + i.qty, 0);

  // Priced before it is placed, from the same unit costs the order will carry.
  // The MOQ floor is NOT applied here: it belongs to the write path, and
  // guessing at it in the preview would show a total the order might not have.
  const costByProduct = new Map((supplier?.products ?? []).map((p) => [p.id, p.costKes]));
  const previewKes = items.reduce((s, i) => s + i.qty * (costByProduct.get(i.productId) ?? 0), 0);

  const reset = () => {
    setQtys({});
    setSearch("");
  };

  const submit = () => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await createManualPoAction({ supplierId, items });
      if (result.ok) {
        setMessage(result.message ?? null);
        reset();
      } else {
        setError(result.error);
      }
    });
  };

  if (suppliers.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Order something not on the list"
        subtitle="For a one-off buy the forecast hasn't asked for"
        action={
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Build an order"}
          </Button>
        }
      />
      {open && (
        <CardContent className="pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-ink-muted" htmlFor="manual-po-supplier">
              Supplier
            </label>
            <Select
              id="manual-po-supplier"
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value);
                reset();
                setError(null);
                setMessage(null);
              }}
              disabled={pending}
            >
              <option value="">Choose…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.moq > 1 ? ` · MOQ ${s.moq}` : ""}
                </option>
              ))}
            </Select>
            {supplier && supplier.products.length > 8 && (
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a product"
                aria-label="Find a product"
                className="h-9 w-56 rounded-md border border-edge bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            )}
          </div>

          {supplier && (
            <ul className="mt-4 divide-y divide-edge border-y border-edge">
              {shown.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">{p.title}</div>
                    <div className="font-mono text-xs text-ink-muted">
                      {p.sku} · {p.currentStock} in stock
                    </div>
                  </div>
                  <CostValue amount={p.costKes} canViewCosts={canViewCosts} />
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={qtys[p.id] ?? ""}
                    onChange={(e) => setQtys((q) => ({ ...q, [p.id]: e.target.value }))}
                    aria-label={`Order quantity for ${p.title}`}
                    className="h-9 w-20 rounded-md border border-edge bg-surface px-2 text-right text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                </li>
              ))}
              {shown.length === 0 && (
                <li className="py-3 text-sm text-ink-muted">Nothing matches that search.</li>
              )}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {units > 0 && (
              <span className="text-sm text-ink">
                {units} {units === 1 ? "unit" : "units"} ·{" "}
                <CostValue amount={previewKes} canViewCosts={canViewCosts} compact />
                {supplier && supplier.moq > 1 && (
                  <span className="ml-2 text-xs text-ink-muted">
                    before this supplier&rsquo;s minimum of {supplier.moq} is applied
                  </span>
                )}
              </span>
            )}
            <span className="ml-auto" />
            {error && <span className="text-sm text-negative">{error}</span>}
            {message && <span className="text-sm text-positive">{message}</span>}
            <Button
              size="sm"
              onClick={submit}
              loading={pending}
              disabled={!supplierId || items.length === 0 || pending}
            >
              Create draft order
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
