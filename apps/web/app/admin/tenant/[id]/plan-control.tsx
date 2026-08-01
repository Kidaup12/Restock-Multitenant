"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PLAN_ORDER, PLAN_TIER_LABEL, type PlanTier } from "@/lib/capabilities/plan-features";
import { setTenantPlan } from "@/app/admin/actions";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";
import { StepUpPrompt } from "@/app/admin/step-up-prompt";

/**
 * Move a workspace between tiers. The one control on this console that changes
 * what a customer can reach, so it states the consequence rather than just
 * saving: the tier decides Insights, Transfers, the budget planner and supplier
 * PO email, and the change takes effect on the customer's next page load.
 */
export function PlanControl({ tenantId, plan }: { tenantId: string; plan: string | null }) {
  // A null plan IS the entry tier (@wezesha/db DEFAULT_PLAN) — shown as such
  // rather than as "unset", which would read like a fault.
  const current = (PLAN_ORDER as readonly string[]).includes(plan ?? "")
    ? (plan as PlanTier)
    : "starter";
  const [choice, setChoice] = useState<PlanTier>(current);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const router = useRouter();

  function save() {
    setNote(null);
    startTransition(async () => {
      const body = new FormData();
      body.set("tenantId", tenantId);
      body.set("plan", choice);
      const result = await setTenantPlan(body);
      if (result.ok) {
        setNeedsStepUp(false);
        setNote({ tone: "positive", text: `Now on ${PLAN_TIER_LABEL[result.plan as PlanTier]}.` });
        router.refresh();
      } else if (result.error === STEP_UP_REQUIRED) {
        // The chosen tier stays selected; confirming carries straight on to it.
        setNeedsStepUp(true);
      } else {
        setNote({ tone: "negative", text: result.error });
      }
    });
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="plan" className="text-ink-muted">
          Tier
        </label>
        <select
          id="plan"
          value={choice}
          onChange={(e) => setChoice(e.target.value as PlanTier)}
          className="rounded-md border border-edge bg-surface px-2 py-1 text-ink"
        >
          {PLAN_ORDER.map((tier) => (
            <option key={tier} value={tier}>
              {PLAN_TIER_LABEL[tier]}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={save} loading={pending} disabled={choice === current}>
          {choice === current ? "Current tier" : "Change tier"}
        </Button>
        {note && (
          <span
            className={note.tone === "positive" ? "text-xs font-medium text-positive" : "text-xs font-medium text-negative"}
          >
            {note.text}
          </span>
        )}
      </div>
      {needsStepUp && (
        <StepUpPrompt
          action="change this workspace's tier"
          onConfirmed={() => {
            setNeedsStepUp(false);
            save();
          }}
          onCancel={() => setNeedsStepUp(false)}
        />
      )}
      <p className="text-xs text-ink-muted">
        The tier decides Insights, Transfers, the budget planner and emailing a purchase order to a
        supplier. A change applies on the workspace&apos;s next page load, and is written to the
        audit trail.
      </p>
    </div>
  );
}
