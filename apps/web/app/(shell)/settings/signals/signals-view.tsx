"use client";

import { useState, useTransition } from "react";
import { TrashIcon } from "@/components/icons";
import type { DeclaredClosure, DeclaredPromo, SignalsCatalogue } from "@/lib/data/signals";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  declareClosure,
  declarePromo,
  removeClosureDay,
  removePromo,
  type SignalActionResult,
} from "./actions";

/**
 * Declare form + list for promotions and closed days. Everything the owner picks
 * here is re-validated in the server action; `canManage` only decides whether
 * the controls are usable.
 */

const PROMO_TYPE_OPTIONS = [
  { value: "discount", label: "Discount" },
  { value: "giveaway", label: "Giveaway" },
  { value: "bundle", label: "Bundle or offer" },
  { value: "flash", label: "Flash sale" },
];

const SCOPE_OPTIONS = [
  { value: "all", label: "Everything in the shop" },
  { value: "brand", label: "One brand" },
  { value: "category", label: "One category" },
  { value: "sku", label: "One product" },
];

const CLOSURE_REASON_OPTIONS = [
  { value: "closed", label: "Shop was closed" },
  { value: "holiday", label: "Public holiday" },
  { value: "refit", label: "Refit or repairs" },
  { value: "stocktake", label: "Stock take" },
];

const REASON_LABEL: Record<string, string> = Object.fromEntries(
  CLOSURE_REASON_OPTIONS.map((o) => [o.value, o.label])
);

const STATUS_BADGE: Record<DeclaredPromo["status"], { tone: "neutral" | "accent" | "positive"; label: string }> = {
  running: { tone: "accent", label: "Running now" },
  upcoming: { tone: "neutral", label: "Coming up" },
  past: { tone: "positive", label: "Finished" },
};


const todayKey = () => new Date().toISOString().slice(0, 10);

export function SignalsView({
  promos,
  closures,
  locations,
  catalogue,
  canManage,
}: {
  promos: DeclaredPromo[];
  closures: DeclaredClosure[];
  locations: { id: string; name: string; sells: boolean }[];
  catalogue: SignalsCatalogue;
  canManage: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<SignalActionResult>, onDone?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage(result.message ?? "Saved.");
        onDone?.();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {message && (
        <p className="rounded-md bg-positive-soft px-3 py-2 text-sm text-positive">{message}</p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}
      {!canManage && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-secondary">
          You can see what’s been declared. Ask someone with settings access to add or remove one.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <PromoForm catalogue={catalogue} canManage={canManage} pending={pending} run={run} />
        <ClosureForm locations={locations} canManage={canManage} pending={pending} run={run} />
      </div>

      <Card>
        <CardHeader
          title="Promotions you've declared"
          subtitle="Sales on these days don't set your normal rate"
        />
        <CardContent className="p-0 pt-4">
          {promos.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-ink-muted">
              Nothing declared yet. Every day counts as a normal trading day.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableHead>When</TableHead>
                <TableHead>What it covered</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead numeric>Discount</TableHead>
                <TableHead numeric>Days left out</TableHead>
                {/* Always here so the table has one shape; the remove button
                    inside it stays with the permission. */}
                <TableHead>{""}</TableHead>
              </TableHeader>
              <TableBody>
                {promos.map((promo) => {
                  const status = STATUS_BADGE[promo.status];
                  return (
                    <TableRow key={promo.id}>
                      <TableCell className="font-medium text-ink">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          {promo.rangeLabel}
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </span>
                        {promo.notes && (
                          <p className="mt-0.5 text-xs text-ink-muted">{promo.notes}</p>
                        )}
                      </TableCell>
                      <TableCell>{promo.scopeLabel}</TableCell>
                      <TableCell className="capitalize">{promo.promoType}</TableCell>
                      <TableCell numeric>
                        {promo.discountPct > 0 ? `${promo.discountPct}%` : "—"}
                      </TableCell>
                      <TableCell numeric>{promo.daysExcluded}</TableCell>
                      <TableCell>
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            aria-label={`Remove the promotion on ${promo.rangeLabel}`}
                            onClick={() => {
                              if (!window.confirm("Remove this promotion? Those days go back to counting as normal sales.")) return;
                              run(() => removePromo({ promoId: promo.id }));
                            }}
                          >
                            <TrashIcon className="size-3.5" />
                            Remove
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Days you were shut"
          subtitle="Includes days marked closed from the Sales screen"
        />
        <CardContent className="p-0 pt-4">
          {closures.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-ink-muted">
              No closed days in the last year.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Day</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>Effect on your rate</TableHead>
                <TableHead>{""}</TableHead>
              </TableHeader>
              <TableBody>
                {closures.map((closure) => (
                  <TableRow key={`${closure.locationId}-${closure.dayKey}`}>
                    <TableCell className="font-medium text-ink">{closure.dayLabel}</TableCell>
                    <TableCell>{closure.locationName}</TableCell>
                    <TableCell>
                      {REASON_LABEL[closure.reason] ?? closure.reason}
                      {closure.note && (
                        <p className="mt-0.5 text-xs text-ink-muted">{closure.note}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {closure.countsAsClosed ? (
                        <Badge tone="positive">Left out</Badge>
                      ) : (
                        <Badge tone="neutral">Still counts — another shop traded</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          aria-label={`Remove the closed day on ${closure.dayLabel}`}
                          onClick={() => {
                            if (!window.confirm("Remove this closed day? It'll count as a trading day again.")) return;
                            run(() =>
                              removeClosureDay({
                                locationId: closure.locationId,
                                dayKey: closure.dayKey,
                              })
                            );
                          }}
                        >
                          <TrashIcon className="size-3.5" />
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PromoForm({
  catalogue,
  canManage,
  pending,
  run,
}: {
  catalogue: SignalsCatalogue;
  canManage: boolean;
  pending: boolean;
  run: (action: () => Promise<SignalActionResult>, onDone?: () => void) => void;
}) {
  const [promoType, setPromoType] = useState("discount");
  const [startDate, setStartDate] = useState(todayKey);
  const [endDate, setEndDate] = useState(todayKey);
  const [scope, setScope] = useState("all");
  const [scopeValue, setScopeValue] = useState("");
  const [discountPct, setDiscountPct] = useState("");
  const [notes, setNotes] = useState("");

  const scopeChoices =
    scope === "brand"
      ? catalogue.brands.map((b) => ({ value: b, label: b }))
      : scope === "category"
        ? catalogue.categories.map((c) => ({ value: c, label: c }))
        : scope === "sku"
          ? catalogue.products.map((p) => ({ value: p.sku, label: `${p.title} (${p.sku})` }))
          : [];

  const submit = () =>
    run(
      () => declarePromo({ startDate, endDate, scope, scopeValue, promoType, discountPct, notes }),
      () => {
        setScopeValue("");
        setDiscountPct("");
        setNotes("");
      }
    );

  return (
    <Card>
      <CardHeader
        title="Declare a promotion"
        subtitle="A giveaway, discount or offer that pushed sales above normal"
      />
      <CardContent className="space-y-4">
        <Field label="What kind" htmlFor="promo-type">
          <Select
            id="promo-type"
            value={promoType}
            disabled={!canManage || pending}
            onChange={(e) => setPromoType(e.target.value)}
          >
            {PROMO_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First day" htmlFor="promo-start">
            <Input
              id="promo-start"
              type="date"
              value={startDate}
              disabled={!canManage || pending}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="Last day" htmlFor="promo-end">
            <Input
              id="promo-end"
              type="date"
              value={endDate}
              disabled={!canManage || pending}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>

        <Field label="What it covered" htmlFor="promo-scope">
          <Select
            id="promo-scope"
            value={scope}
            disabled={!canManage || pending}
            onChange={(e) => {
              setScope(e.target.value);
              setScopeValue("");
            }}
          >
            {SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        {scope !== "all" && (
          <Field label="Which one" htmlFor="promo-scope-value">
            <Select
              id="promo-scope-value"
              value={scopeValue}
              disabled={!canManage || pending}
              onChange={(e) => setScopeValue(e.target.value)}
            >
              <option value="">Pick one…</option>
              {scopeChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Discount"
          htmlFor="promo-discount"
          hint={<span className="text-xs text-ink-muted">Optional, %</span>}
        >
          <Input
            id="promo-discount"
            type="number"
            min={0}
            max={95}
            inputMode="numeric"
            placeholder="e.g. 20"
            value={discountPct}
            disabled={!canManage || pending}
            onChange={(e) => setDiscountPct(e.target.value)}
          />
        </Field>

        <Field
          label="Note"
          htmlFor="promo-notes"
          hint={<span className="text-xs text-ink-muted">Optional</span>}
        >
          <Input
            id="promo-notes"
            placeholder="What was it for?"
            value={notes}
            disabled={!canManage || pending}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <Button onClick={submit} disabled={!canManage} loading={pending}>
          Save promotion
        </Button>
      </CardContent>
    </Card>
  );
}

function ClosureForm({
  locations,
  canManage,
  pending,
  run,
}: {
  locations: { id: string; name: string; sells: boolean }[];
  canManage: boolean;
  pending: boolean;
  run: (action: () => Promise<SignalActionResult>, onDone?: () => void) => void;
}) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [startDate, setStartDate] = useState(todayKey);
  const [endDate, setEndDate] = useState(todayKey);
  const [reason, setReason] = useState("closed");
  const [note, setNote] = useState("");

  const submit = () =>
    run(
      () => declareClosure({ locationId, startDate, endDate, reason, note }),
      () => setNote("")
    );

  return (
    <Card>
      <CardHeader
        title="Declare closed days"
        subtitle="Days the shop didn't trade — a holiday, a refit, a stock take"
      />
      <CardContent className="space-y-4">
        <Field label="Which location" htmlFor="closure-location">
          <Select
            id="closure-location"
            value={locationId}
            disabled={!canManage || pending || locations.length === 0}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First day" htmlFor="closure-start">
            <Input
              id="closure-start"
              type="date"
              value={startDate}
              disabled={!canManage || pending}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="Last day" htmlFor="closure-end">
            <Input
              id="closure-end"
              type="date"
              value={endDate}
              disabled={!canManage || pending}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Why" htmlFor="closure-reason">
          <Select
            id="closure-reason"
            value={reason}
            disabled={!canManage || pending}
            onChange={(e) => setReason(e.target.value)}
          >
            {CLOSURE_REASON_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Note"
          htmlFor="closure-note"
          hint={<span className="text-xs text-ink-muted">Optional</span>}
        >
          <Input
            id="closure-note"
            placeholder="Anything worth remembering"
            value={note}
            disabled={!canManage || pending}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <Button onClick={submit} disabled={!canManage || locations.length === 0} loading={pending}>
          Save closed days
        </Button>
      </CardContent>
    </Card>
  );
}
