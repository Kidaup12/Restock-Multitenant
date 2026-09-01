"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { acceptTermsAction } from "./settings/terms-actions";

/**
 * The terms, asked before the app rather than offered inside it.
 *
 * Acceptance was recorded properly — version-stamped, per membership, written
 * to the audit ledger — but only reachable by going to Settings and looking for
 * it. So the record existed and was empty for anyone who never went looking,
 * which is a consent trail that proves nothing.
 *
 * This blocks the shell instead. It covers signup and invitation in one place
 * because both arrive at the same layout: a new owner sees it on their first
 * load, and so does a teammate the moment they accept an invite.
 *
 * Deliberately not dismissible and with no way past it but accepting. A consent
 * gate with a skip is a worse lie than no gate — it produces a record that says
 * someone agreed when the product let them through either way. Sign out is the
 * other door, and it is in the sidebar behind this overlay.
 */
export function TermsGate({ version }: { version: string }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function accept() {
    setError(null);
    start(async () => {
      const result = await acceptTermsAction();
      if (result.ok) {
        // The layout re-reads acceptance on the server; refresh drops the gate.
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-gate-title"
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border border-edge bg-surface p-6 shadow-pop">
        <h1 id="terms-gate-title" className="text-lg font-semibold text-ink">
          Terms &amp; Conditions
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          Before you continue, please review and accept our{" "}
          <a className="text-accent underline" href="/terms" target="_blank" rel="noreferrer">
            Terms &amp; Conditions
          </a>{" "}
          and{" "}
          <a className="text-accent underline" href="/privacy" target="_blank" rel="noreferrer">
            Privacy Policy
          </a>
          .
        </p>

        <label className="mt-5 flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={checked}
            disabled={pending}
            onChange={(e) => setChecked(e.target.checked)}
          />
          I have read and agree to the Terms &amp; Conditions and Privacy Policy.
        </label>

        {error && (
          <p className="mt-3 rounded-md bg-negative-soft px-3 py-2 text-sm text-negative" role="alert">
            {error}
          </p>
        )}

        <Button
          className="mt-5 w-full"
          onClick={accept}
          loading={pending}
          // The tickbox is the consent; the button only records it. Enabling it
          // unticked would let a stray click stand as agreement.
          disabled={!checked || pending}
        >
          Accept &amp; continue
        </Button>

        <p className="mt-3 text-xs text-ink-faint">Version {version}</p>
      </div>
    </div>
  );
}
