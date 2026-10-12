"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
import {
  PLAN_FEATURE_LABEL,
  PLAN_FEATURES,
  type FeatureOverride,
  type FeatureOverrides,
  type PlanFeature,
} from "@/lib/capabilities/plan-features";
import { FEATURE_KEYS, type FeatureKey } from "@/lib/capabilities/feature-flags";
import { setTenantFeatureFlag, setTenantFeatureOverride } from "@/app/admin/actions";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";
import { StepUpPrompt } from "@/app/admin/step-up-prompt";

/**
 * Two per-tenant knobs finer than the tier, on one card.
 *
 * The top block is capability gate 2: grant or deny each PLAN feature over the
 * top of the tier, for the cases a whole-bundle tier can't express — a paid
 * add-on, a pilot, a make-good, or a feature pulled for one shop. "Inherit"
 * removes the override and lets the tier decide again.
 *
 * The bottom block is capability gate 4: the tenant feature SWITCHES the
 * customer normally flips in their own Settings — surfaced here so support can
 * turn one back on without database access. Both write behind the same step-up
 * every other console mutation asks for; the value the operator picks is kept
 * selected across the prompt so confirming carries straight on.
 */

type TriState = FeatureOverride | "inherit";

/** The switches, in the shop's words. Kept here rather than shared because this
 *  is the only surface that names them for an operator. */
const SWITCH_LABEL: Record<FeatureKey, string> = {
  transfers: "Transfers surface",
  pos_feed: "POS feed",
  quickbooks: "QuickBooks",
  supplier_email: "Email POs to suppliers",
  weekly_digest: "Weekly email digest",
};

const PLAN_FEATURE_KEYS = Object.keys(PLAN_FEATURES) as PlanFeature[];

export function FeatureAccessControl({
  tenantId,
  overrides,
  flags,
}: {
  tenantId: string;
  overrides: FeatureOverrides;
  flags: Record<FeatureKey, boolean>;
}) {
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  // The one confirm prompt serves whichever knob was just touched: remember the
  // action to re-run once step-up clears.
  const [pendingConfirm, setPendingConfirm] = useState<null | (() => void)>(null);
  const router = useRouter();

  return (
    <div className="space-y-5 text-sm">
      <div className="space-y-3">
        <p className="text-2xs font-medium tracking-wider text-ink-muted uppercase">
          Plan features
        </p>
        <ul className="divide-y divide-edge rounded-md border border-edge">
          {PLAN_FEATURE_KEYS.map((feature) => (
            <OverrideRow
              key={feature}
              tenantId={tenantId}
              feature={feature}
              value={overrides[feature] ?? "inherit"}
              onNote={setNote}
              onNeedsStepUp={setPendingConfirm}
              onDone={() => router.refresh()}
            />
          ))}
        </ul>
        <p className="text-xs text-ink-muted">
          A grant turns a feature on regardless of tier; a deny turns it off. Inherit lets the tier
          decide. The change applies on the workspace&apos;s next page load and is written to the
          audit trail.
        </p>
      </div>

      <div className="space-y-3">
        <p className="text-2xs font-medium tracking-wider text-ink-muted uppercase">
          Feature switches
        </p>
        <ul className="divide-y divide-edge rounded-md border border-edge">
          {FEATURE_KEYS.map((key) => (
            <SwitchRow
              key={key}
              tenantId={tenantId}
              feature={key}
              enabled={flags[key]}
              onNote={setNote}
              onNeedsStepUp={setPendingConfirm}
              onDone={() => router.refresh()}
            />
          ))}
        </ul>
        <p className="text-xs text-ink-muted">
          The same switches the customer sets in their own Settings — surfaced here so support can
          turn one back on.
        </p>
      </div>

      {note && (
        <span
          className={
            note.tone === "positive"
              ? "text-xs font-medium text-positive"
              : "text-xs font-medium text-negative"
          }
        >
          {note.text}
        </span>
      )}

      {pendingConfirm && (
        <StepUpPrompt
          action="change this workspace's feature access"
          onConfirmed={() => {
            const run = pendingConfirm;
            setPendingConfirm(null);
            run();
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}

function OverrideRow({
  tenantId,
  feature,
  value,
  onNote,
  onNeedsStepUp,
  onDone,
}: {
  tenantId: string;
  feature: PlanFeature;
  value: TriState;
  onNote: (n: { tone: "positive" | "negative"; text: string } | null) => void;
  onNeedsStepUp: (run: () => void) => void;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<TriState>(value);
  const [pending, startTransition] = useTransition();

  function save(next: TriState) {
    onNote(null);
    startTransition(async () => {
      const body = new FormData();
      body.set("tenantId", tenantId);
      body.set("feature", feature);
      body.set("value", next);
      const result = await setTenantFeatureOverride(body);
      if (result.ok) {
        onNote({ tone: "positive", text: `${PLAN_FEATURE_LABEL[feature]}: ${next}.` });
        onDone();
      } else if (result.error === STEP_UP_REQUIRED) {
        // Keep the picked value selected and re-run on confirm.
        onNeedsStepUp(() => save(next));
      } else {
        // Roll the select back to what is actually stored.
        setChoice(value);
        onNote({ tone: "negative", text: result.error });
      }
    });
  }

  return (
    <li className="flex items-center justify-between gap-4 px-3 py-2">
      <span className="text-ink-secondary">{PLAN_FEATURE_LABEL[feature]}</span>
      <Select
        size="sm"
        aria-label={`${PLAN_FEATURE_LABEL[feature]} access`}
        value={choice}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as TriState;
          setChoice(next);
          save(next);
        }}
      >
        <option value="inherit">Inherit tier</option>
        <option value="grant">Grant</option>
        <option value="deny">Deny</option>
      </Select>
    </li>
  );
}

function SwitchRow({
  tenantId,
  feature,
  enabled,
  onNote,
  onNeedsStepUp,
  onDone,
}: {
  tenantId: string;
  feature: FeatureKey;
  enabled: boolean;
  onNote: (n: { tone: "positive" | "negative"; text: string } | null) => void;
  onNeedsStepUp: (run: () => void) => void;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<boolean>(enabled);
  const [pending, startTransition] = useTransition();

  function save(next: boolean) {
    onNote(null);
    startTransition(async () => {
      const body = new FormData();
      body.set("tenantId", tenantId);
      body.set("feature", feature);
      body.set("enabled", String(next));
      const result = await setTenantFeatureFlag(body);
      if (result.ok) {
        onNote({ tone: "positive", text: `${SWITCH_LABEL[feature]}: ${next ? "on" : "off"}.` });
        onDone();
      } else if (result.error === STEP_UP_REQUIRED) {
        onNeedsStepUp(() => save(next));
      } else {
        setChoice(enabled);
        onNote({ tone: "negative", text: result.error });
      }
    });
  }

  return (
    <li className="flex items-center justify-between gap-4 px-3 py-2">
      <span className="text-ink-secondary">{SWITCH_LABEL[feature]}</span>
      <Select
        size="sm"
        aria-label={`${SWITCH_LABEL[feature]} switch`}
        value={choice ? "true" : "false"}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value === "true";
          setChoice(next);
          save(next);
        }}
      >
        <option value="true">On</option>
        <option value="false">Off</option>
      </Select>
    </li>
  );
}
