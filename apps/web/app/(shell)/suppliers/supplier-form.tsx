"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SupplierRow } from "@/lib/data/suppliers";
import {
  createSupplierAction,
  updateSupplierAction,
  type SupplierActionResult,
  type SupplierInput,
} from "./actions";

const CURRENCIES = ["KES", "USD", "CNY", "AED"] as const;

const selectClass = cn(
  "h-10 w-full rounded-md border border-edge bg-surface px-3 text-sm text-ink transition-colors",
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
  "disabled:pointer-events-none disabled:opacity-60",
);

/** Add-by-hand / edit form for a supplier. Gated by canManage upstream. */
export function SupplierForm({
  supplier,
  onResult,
  onClose,
}: {
  /** null/undefined = a new supplier. */
  supplier?: SupplierRow | null;
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
        : await createSupplierAction(payload);
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
            <select
              id="sf-currency"
              className={selectClass}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
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
