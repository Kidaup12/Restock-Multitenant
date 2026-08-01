"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { confirmStepUp } from "./step-up-actions";

/**
 * Password confirmation, shown in place when a mutation asks for it.
 *
 * Inline rather than a redirect so whatever was typed survives: being sent away
 * to a password page and back, having lost the form, teaches people to step up
 * pre-emptively and keep the grant warm — the exact habit this is meant to
 * prevent. `onConfirmed` re-runs the action the caller was already attempting.
 */
export function StepUpPrompt({
  action,
  onConfirmed,
  onCancel,
}: {
  /** What the admin is about to do, e.g. "change this workspace's plan". */
  action: string;
  onConfirmed: () => void;
  onCancel?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const body = new FormData();
      body.set("password", password);
      const result = await confirmStepUp(body);
      if (result.ok) {
        setPassword("");
        onConfirmed();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="rounded-md border border-edge bg-page p-3">
      <p className="text-sm text-ink">
        Confirm your password to {action}.
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        Asked once every 30 minutes, so a signed-in laptop left open is not a way into a
        customer&apos;s workspace.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="w-56 rounded-md border border-edge bg-surface px-3 py-2 text-sm text-ink"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && password.length > 0 && !pending) submit();
          }}
          placeholder="Your password"
          aria-label="Your password"
        />
        <Button size="sm" onClick={submit} loading={pending} disabled={password.length === 0}>
          Confirm
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {error && <span className="text-xs font-medium text-negative">{error}</span>}
      </div>
    </div>
  );
}
