"use client";

import { useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { CheckIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { SetupStep } from "@/lib/capabilities/setup-checklist";
import { setupProgress } from "@/lib/capabilities/setup-checklist";

/**
 * What is left before the buy list means anything, as a list the shop can work
 * down. Each unfinished step carries the screen that finishes it — a checklist
 * that names work without offering the way to do it is a nag.
 *
 * It disappears at full setup, and can be dismissed before then: a shop that has
 * decided to live without supplier lead times should not be told about it every
 * morning. The dismissal is per workspace and per browser, which is the right
 * grain for "I've read this" and the wrong one for anything load-bearing —
 * nothing gates on it.
 */

const dismissKey = (tenantId: string) => `wz-setup-dismissed:${tenantId}`;

/* The dismissal lives in localStorage, which is external state, so it is
 * subscribed to rather than copied into React state in an effect — copying it
 * means a render with the wrong answer followed by a second one to correct it. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab dismissing it should settle this one too.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readDismissed(tenantId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(tenantId)) === "1";
  } catch {
    // A browser refusing storage should still see the checklist.
    return false;
  }
}

/** Circumference of the r=15 ring, so the dash offset is a plain percentage. */
const RING = 2 * Math.PI * 15;

function ProgressRing({ percent }: { percent: number }) {
  return (
    <svg width="44" height="44" viewBox="0 0 36 36" aria-hidden className="shrink-0 -rotate-90">
      <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-edge" />
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={RING}
        strokeDashoffset={RING * (1 - percent / 100)}
        className="stroke-accent transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

function StepRow({ step, index }: { step: SetupStep; index: number }) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full text-2xs font-medium",
          step.done
            ? "bg-positive-soft text-positive [&_svg]:size-3"
            : "border border-edge-strong bg-surface-2 text-ink-muted"
        )}
      >
        {step.done ? <CheckIcon /> : index + 1}
      </span>

      <span className="min-w-0 flex-1 text-sm">
        <span className={cn("font-medium", step.done ? "text-ink-muted line-through" : "text-ink")}>
          {step.label}
        </span>
        <span className="text-ink-muted"> — {step.detail}</span>
      </span>

      {!step.done &&
        (step.actionable ? (
          <Link
            href={step.href}
            className="shrink-0 text-sm font-medium text-accent-ink hover:underline"
          >
            Set up →
          </Link>
        ) : (
          // Naming the role beats a link that dead-ends on a permission error.
          <span className="shrink-0 text-2xs text-ink-faint" title="An owner or admin sets this up">
            Owner or admin
          </span>
        ))}
    </li>
  );
}

export function FinishSetupCard({ steps, tenantId }: { steps: SetupStep[]; tenantId: string }) {
  const { done, total, percent } = setupProgress(steps);
  const dismissed = useSyncExternalStore(
    subscribe,
    useCallback(() => readDismissed(tenantId), [tenantId]),
    // The server cannot know, so it renders nothing and hydration decides. The
    // other way round flashes a checklist at a shop that already dismissed it.
    () => true
  );

  function dismiss() {
    try {
      window.localStorage.setItem(dismissKey(tenantId), "1");
    } catch {
      /* nothing to persist to; the card simply comes back next visit */
    }
    for (const onChange of listeners) onChange();
  }

  // Nothing left to finish, or the shop has already read it.
  if (done === total || dismissed) return null;

  return (
    <Card className="px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="relative grid place-items-center">
          <ProgressRing percent={percent} />
          <span className="absolute font-mono text-2xs font-semibold text-ink">{percent}%</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium text-ink">
                Finish setup ({done}/{total})
              </h2>
              <p className="text-xs text-ink-muted">
                A few things left before the buy list can do its job.
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Hide the setup checklist"
              title="Hide this — the steps stay on Settings"
              className="-m-1 shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              ×
            </button>
          </div>

          <ol className="mt-2 divide-y divide-edge">
            {steps.map((step, i) => (
              <StepRow key={step.id} step={step} index={i} />
            ))}
          </ol>
        </div>
      </div>
    </Card>
  );
}
