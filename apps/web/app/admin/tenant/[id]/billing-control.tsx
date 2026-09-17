"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { setTenantBilling } from "@/app/admin/actions";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";
import { StepUpPrompt } from "@/app/admin/step-up-prompt";

/**
 * Set a workspace's billing period and status.
 *
 * There is no self-serve billing yet, so the period a customer is paid up to and
 * their status are operator facts. Two common moves get their own button — extend
 * by 30 days, and mark a status — and an explicit date is there for the rest. The
 * enforcement cron reads what this writes: past a grace window it softens a
 * lapsed workspace to past_due, so setting a real period here is what keeps that
 * honest.
 *
 * Behind the same step-up as every other console mutation; the form state
 * survives the prompt so confirming carries straight on.
 */

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  trialing: "Trialing",
  past_due: "Past due",
  canceled: "Cancelled",
};

const STATUSES = ["active", "trialing", "past_due", "canceled"] as const;

/** A stored ISO instant rendered as the plain UTC day the operator set. */
function asDayInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

export function BillingControl({
  tenantId,
  periodEnd,
  status,
  note,
}: {
  tenantId: string;
  periodEnd: string | null;
  status: string | null;
  note: string | null;
}) {
  const [choiceStatus, setChoiceStatus] = useState<string>(status ?? "active");
  const [date, setDate] = useState<string>(asDayInput(periodEnd));
  const [noteText, setNoteText] = useState<string>(note ?? "");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "positive" | "negative"; text: string } | null>(
    null
  );
  // The period change to send with the next save: "keep" unless a button chose
  // otherwise. Held so the step-up re-run repeats the exact same intent.
  const [pendingRun, setPendingRun] = useState<null | (() => void)>(null);
  const router = useRouter();

  function save(periodMode: "keep" | "extend" | "date" | "clear") {
    setMessage(null);
    startTransition(async () => {
      const body = new FormData();
      body.set("tenantId", tenantId);
      body.set("status", choiceStatus);
      body.set("periodMode", periodMode);
      if (periodMode === "date") body.set("periodEnd", date);
      body.set("note", noteText);
      const result = await setTenantBilling(body);
      if (result.ok) {
        setPendingRun(null);
        setDate(asDayInput(result.periodEnd));
        setMessage({
          tone: "positive",
          text: result.periodEnd
            ? `${STATUS_LABEL[result.status] ?? result.status} · paid to ${result.periodEnd.slice(0, 10)}.`
            : `${STATUS_LABEL[result.status] ?? result.status} · no period set.`,
        });
        router.refresh();
      } else if (result.error === STEP_UP_REQUIRED) {
        setPendingRun(() => () => save(periodMode));
      } else {
        setMessage({ tone: "negative", text: result.error });
      }
    });
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="billing-status"
          className="text-2xs font-medium tracking-wider text-ink-muted uppercase"
        >
          Status
        </label>
        <Select
          size="sm"
          id="billing-status"
          value={choiceStatus}
          onChange={(e) => setChoiceStatus(e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" onClick={() => save("keep")} loading={pending}>
          Save status
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="billing-date"
          className="text-2xs font-medium tracking-wider text-ink-muted uppercase"
        >
          Paid to
        </label>
        <Input
          size="sm"
          id="billing-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-40"
        />
        <Button size="sm" variant="ghost" onClick={() => save("date")} loading={pending} disabled={!date}>
          Set date
        </Button>
        <Button size="sm" onClick={() => save("extend")} loading={pending}>
          +30 days
        </Button>
        {periodEnd && (
          <Button size="sm" variant="ghost" onClick={() => save("clear")} loading={pending}>
            Clear
          </Button>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="billing-note"
          className="text-2xs font-medium tracking-wider text-ink-muted uppercase"
        >
          Note
        </label>
        <Input
          size="sm"
          id="billing-note"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="e.g. invoiced offline, net-30"
          maxLength={500}
        />
      </div>

      {message && (
        <span
          className={
            message.tone === "positive"
              ? "text-xs font-medium text-positive"
              : "text-xs font-medium text-negative"
          }
        >
          {message.text}
        </span>
      )}

      {pendingRun && (
        <StepUpPrompt
          action="change this workspace's billing"
          onConfirmed={() => {
            const run = pendingRun;
            setPendingRun(null);
            run();
          }}
          onCancel={() => setPendingRun(null)}
        />
      )}
    </div>
  );
}
