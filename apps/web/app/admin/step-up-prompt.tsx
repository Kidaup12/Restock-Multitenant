"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/auth/password-input";
import { Input } from "@/components/ui/input";
import {
  confirmStepUp,
  confirmStepUpCode,
  sendStepUpCode,
  stepUpFactor,
} from "./step-up-actions";

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
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  /**
   * Asked rather than assumed. An account created through email-code sign-in has
   * no password, and offering it a password box is offering something it can
   * never satisfy - which locked such an admin out of every mutation the console
   * has, including the one that would fix it.
   */
  const [factor, setFactor] = useState<"loading" | "password" | "code">("loading");

  useEffect(() => {
    let live = true;
    void stepUpFactor().then((f) => live && setFactor(f));
    return () => {
      live = false;
    };
  }, []);

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

  function sendCode() {
    setError(null);
    startTransition(async () => {
      const result = await sendStepUpCode();
      if (result.ok) setSent(true);
      else setError(result.error);
    });
  }

  function submitCode() {
    setError(null);
    startTransition(async () => {
      const body = new FormData();
      body.set("code", code);
      const result = await confirmStepUpCode(body);
      if (result.ok) {
        setCode("");
        onConfirmed();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="rounded-md border border-edge bg-page p-3">
      <p className="text-sm text-ink">
        {factor === "code"
          ? `Confirm a code we email you, to ${action}.`
          : `Confirm your password to ${action}.`}
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        Asked once every 30 minutes, so a signed-in laptop left open is not a way into a
        customer&apos;s workspace.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {factor === "loading" && <span className="text-xs text-ink-muted">Checking…</span>}

        {factor === "password" && (
          <>
            {/* The same reveal control as sign-in and the Shopify token field. A
                mistyped password is otherwise invisible until it is refused, and
                this one costs a failed attempt against the lockout counter. */}
            <PasswordInput
              className="w-56"
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
          </>
        )}

        {factor === "code" && !sent && (
          <Button size="sm" onClick={sendCode} loading={pending}>
            Email me a code
          </Button>
        )}

        {factor === "code" && sent && (
          <>
            <Input
              className="w-40"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.length > 0 && !pending) submitCode();
              }}
              placeholder="6-digit code"
              aria-label="Emailed code"
            />
            <Button size="sm" onClick={submitCode} loading={pending} disabled={code.length === 0}>
              Confirm
            </Button>
            <Button variant="ghost" size="sm" onClick={sendCode} disabled={pending}>
              Resend
            </Button>
          </>
        )}

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
