"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { type OrderMethod } from "@wezesha/forecast";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  saveWorkspaceSettings,
  type WorkspaceField,
  type WorkspaceSettingsInput,
} from "./actions";

export type WorkspaceFormValues = {
  name: string;
  timezone: string;
  alertEmail: string;
  deadStockWindowDays: string;
  methodA: OrderMethod;
  methodB: OrderMethod;
  methodC: OrderMethod;
};

export function WorkspaceForm({
  initial,
  timezones,
  currency,
  defaultDeadStockDays,
  fallbackAlertEmail,
  canManage,
}: {
  initial: WorkspaceFormValues;
  /** Every IANA zone the runtime knows, so any shop can be placed correctly. */
  timezones: string[];
  /** Display only — see the page comment on why it isn't editable. */
  currency: string;
  defaultDeadStockDays: number;
  /** Where alerts land while alertEmail is blank (the earliest owner), or null
   *  when the workspace has no owner to fall back to. */
  fallbackAlertEmail: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<WorkspaceField | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof WorkspaceFormValues>(
    key: K,
    value: WorkspaceFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setField(null);
    const input: WorkspaceSettingsInput = { ...values };
    startTransition(async () => {
      const result = await saveWorkspaceSettings(input);
      if (result.ok) {
        setSaved(true);
        // A renamed workspace shows in the shell header, not just this form.
        router.refresh();
        return;
      }
      setError(result.error);
      setField(result.field ?? null);
    });
  }

  const errorFor = (key: WorkspaceField) => (field === key ? error : null);

  return (
    <form onSubmit={submit} className="space-y-6">
      {!canManage && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-secondary">
          You can see these settings but not change them. Ask an owner or admin.
        </p>
      )}

      {error && !field && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      <Card>
        <CardHeader
          title="Workspace"
          subtitle="The name on this workspace and the clock every sales day is measured against"
        />
        <CardContent className="space-y-5 pt-4">
          <Field label="Workspace name" htmlFor="workspace-name" error={errorFor("name")}>
            <Input
              id="workspace-name"
              value={values.name}
              maxLength={80}
              disabled={!canManage || pending}
              aria-invalid={errorFor("name") ? true : undefined}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>

          <Field label="Time zone" htmlFor="workspace-timezone" error={errorFor("timezone")}>
            <Select
              id="workspace-timezone"
              value={values.timezone}
              disabled={!canManage || pending}
              onChange={(e) => set("timezone", e.target.value)}
            >
              {timezones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
            <p className="text-xs text-ink-muted">
              A till sale rung at 23:30 counts as that day, not the next one. Change
              this only if the shop trades somewhere else.
            </p>
          </Field>

          <div className="space-y-1.5">
            <span className="text-sm font-medium text-ink">Currency</span>
            <p className="text-sm text-ink-secondary">{currency}</p>
            <p className="text-xs text-ink-muted">
              Every figure in the app is in {currency}. Trading in another currency
              isn&apos;t supported yet, so this isn&apos;t editable — supplier prices
              in foreign currency are set per supplier instead.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Alerts"
          subtitle="Where we write when a sync breaks or the feed goes quiet"
        />
        <CardContent className="pt-4">
          <Field label="Alert email" htmlFor="workspace-alert-email" error={errorFor("alertEmail")}>
            <Input
              id="workspace-alert-email"
              type="email"
              value={values.alertEmail}
              placeholder={fallbackAlertEmail ?? "you@example.com"}
              disabled={!canManage || pending}
              aria-invalid={errorFor("alertEmail") ? true : undefined}
              onChange={(e) => set("alertEmail", e.target.value)}
            />
            <p className="text-xs text-ink-muted">
              {fallbackAlertEmail
                ? `Leave it blank and alerts go to ${fallbackAlertEmail}.`
                : "Leave it blank and alerts go to the workspace owner."}
            </p>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Dead stock"
          subtitle="How long stock sits unsold before it counts as money stuck on the shelf"
        />
        <CardContent className="pt-4">
          <Field
            label="Unsold for this many days"
            htmlFor="workspace-dead-stock"
            error={errorFor("deadStockWindowDays")}
          >
            <Input
              id="workspace-dead-stock"
              type="number"
              inputMode="numeric"
              min={7}
              max={730}
              className="max-w-40"
              value={values.deadStockWindowDays}
              placeholder={String(defaultDeadStockDays)}
              disabled={!canManage || pending}
              aria-invalid={errorFor("deadStockWindowDays") ? true : undefined}
              onChange={(e) => set("deadStockWindowDays", e.target.value)}
            />
            <p className="text-xs text-ink-muted">
              This is the dead-stock number on Today. Shorter flags slow lines sooner;
              longer is kinder to seasonal stock. Blank uses {defaultDeadStockDays} days.
            </p>
          </Field>
        </CardContent>
      </Card>

      {/* "Buying style" lived here, under the timezone picker and the
          dead-stock window, where nobody looking for it would find it. It
          decides how much cash sits on the shelf against how often the shop
          runs out, so it now has its own page with the trade-offs on screen.
          Left as a pointer rather than a duplicate: two controls writing the
          same three columns is how a screen ends up disagreeing with itself. */}
      <Card>
        <CardHeader
          title="Buying style"
          subtitle="How hard the buy list works to keep each group in stock"
        />
        <CardContent className="pt-4">
          <Link href="/settings/ordering-strategy" className="text-sm text-accent underline">
            Set your ordering strategy →
          </Link>
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex items-center gap-3">
          <Button type="submit" loading={pending}>
            Save changes
          </Button>
          {saved && !pending && (
            <span role="status" className="text-sm text-positive">
              Saved.
            </span>
          )}
        </div>
      )}
    </form>
  );
}
