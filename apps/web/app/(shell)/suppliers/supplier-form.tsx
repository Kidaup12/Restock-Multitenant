"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AssignableProduct, SupplierRow } from "@/lib/data/suppliers";
import {
  createSupplierAction,
  updateSupplierAction,
  type SupplierActionResult,
  type SupplierInput,
} from "./actions";

const CURRENCIES = ["KES", "USD", "CNY", "AED"] as const;


/** Add-by-hand / edit form for a supplier. Gated by canManage upstream. */
export function SupplierForm({
  supplier,
  assignableProducts,
  onResult,
  onClose,
}: {
  /** null/undefined = a new supplier. */
  supplier?: SupplierRow | null;
  /** Candidates for "what do I buy from them?", offered only while creating —
   *  an existing supplier has its own picker with the current set already ticked. */
  assignableProducts: AssignableProduct[];
  onResult: (result: SupplierActionResult) => void;
  onClose: () => void;
}) {
  const editing = !!supplier;
  const [name, setName] = useState(supplier?.name ?? "");
  const [group, setGroup] = useState(supplier?.group ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [country, setCountry] = useState(supplier?.country ?? "");
  const [currency, setCurrency] = useState(supplier?.currency ?? "USD");
  const [lead, setLead] = useState(
    supplier?.leadTimeTypedDays != null ? String(supplier.leadTimeTypedDays) : "",
  );
  const [std, setStd] = useState(
    supplier?.leadTimeStdDays != null ? String(supplier.leadTimeStdDays) : "7",
  );
  const [moq, setMoq] = useState(supplier?.moq != null ? String(supplier.moq) : "1");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [productSearch, setProductSearch] = useState("");

  function toNum(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  function submit() {
    setError(null);
    const payload: SupplierInput = {
      name,
      email,
      country,
      currency,
      supplierGroup: group,
      leadTimeAvgDays: toNum(lead),
      leadTimeStdDays: toNum(std),
      moq: toNum(moq),
    };
    startTransition(async () => {
      const result = editing
        ? await updateSupplierAction({ ...payload, supplierId: supplier!.id })
        : await createSupplierAction({ ...payload, productIds: [...picked] });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onResult(result);
      onClose();
    });
  }

  return (
    <Card>
      <CardHeader title={editing ? `Edit ${supplier!.name}` : "Add a supplier"} />
      <CardContent className="space-y-4 pt-4">
        {error && (
          <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
            {error}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="sf-name">
            <Input id="sf-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Group (optional)" htmlFor="sf-group">
            <Input
              id="sf-group"
              value={group}
              placeholder="Overseas, Local pickup…"
              onChange={(e) => setGroup(e.target.value)}
            />
          </Field>
          <Field label="Email (optional)" htmlFor="sf-email">
            <Input
              id="sf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Country (optional)" htmlFor="sf-country">
            <Input
              id="sf-country"
              value={country}
              placeholder="KE, AE, CN…"
              onChange={(e) => setCountry(e.target.value)}
            />
          </Field>
          <Field label="Currency" htmlFor="sf-currency">
            <Select
              id="sf-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lead time (days, optional)" htmlFor="sf-lead">
            <Input
              id="sf-lead"
              inputMode="numeric"
              value={lead}
              placeholder="e.g. 28"
              onChange={(e) => setLead(e.target.value)}
            />
          </Field>
          <Field label="Lead-time variability (± days)" htmlFor="sf-std">
            <Input
              id="sf-std"
              inputMode="numeric"
              value={std}
              onChange={(e) => setStd(e.target.value)}
            />
          </Field>
          <Field label="Minimum order quantity" htmlFor="sf-moq">
            <Input
              id="sf-moq"
              inputMode="numeric"
              value={moq}
              onChange={(e) => setMoq(e.target.value)}
            />
          </Field>
        </div>

        {/* Only while creating: an existing supplier has its own picker, which
            arrives with the current set already ticked. Asking here saves the
            owner adding a supplier and then hunting for it to attach anything. */}
        {!editing && assignableProducts.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink">What do you buy from them?</p>
            <p className="text-sm text-ink-muted">
              Optional — you can do this later. Picking a product that already has a supplier moves
              it to this one.
            </p>
            <Input
              aria-label="Search products"
              placeholder="Search by name or code"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
            />
            <ul className="max-h-56 divide-y divide-edge overflow-y-auto rounded-md border border-edge">
              {assignableProducts
                .filter((p) => {
                  const q = productSearch.trim().toLowerCase();
                  if (!q) return true;
                  return `${p.title} ${p.sku}`.toLowerCase().includes(q);
                })
                .slice(0, 100)
                .map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-(--accent)"
                      checked={picked.has(p.id)}
                      aria-label={`Buy ${p.title} from this supplier`}
                      onChange={() =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{p.title}</span>
                      <span className="block truncate font-mono text-xs text-ink-faint">
                        {p.sku || "no SKU"}
                        {p.supplierName ? ` · now with ${p.supplierName}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
            {picked.size > 0 && (
              <p className="text-sm text-ink-secondary">
                {picked.size} product{picked.size === 1 ? "" : "s"} will move to this supplier.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={submit} loading={pending}>
            {editing ? "Save changes" : "Add supplier"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
