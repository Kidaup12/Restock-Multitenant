"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { acceptTermsAction } from "./terms-actions";

/**
 * Where a member sees whether they have accepted the published terms, and
 * accepts them if not.
 *
 * Shows the version alongside the date on purpose: "accepted" without saying
 * WHAT was accepted is the same empty reassurance the schema used to give.
 */

function formatAccepted(iso: string): string {
  const at = new Date(iso);
  const date = at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

export function TermsAcceptance({
  acceptedAt,
  acceptedVersion,
  current,
  version,
}: {
  /** ISO string, or null if this member has never accepted. */
  acceptedAt: string | null;
  acceptedVersion: string | null;
  /** Accepted the version currently published. */
  current: boolean;
  version: string;
}) {
  const [at, setAt] = useState(acceptedAt);
  const [accepted, setAccepted] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptTermsAction();
      if (result.ok) {
        setAt(result.at);
        setAccepted(true);
      } else {
        setError(result.error);
      }
    });
  }

  if (accepted && at) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-ink">Your acceptance</div>
          <div className="text-xs text-ink-muted">
            Accepted {formatAccepted(at)} · version {version}
          </div>
        </div>
        <Badge tone="positive">Accepted</Badge>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium text-ink">Your acceptance</div>
        <div className="text-xs text-ink-muted">
          {at && acceptedVersion
            ? `You accepted version ${acceptedVersion}. The terms have changed since.`
            : "Not recorded yet — accepting keeps a dated record against this version."}
        </div>
        {error && (
          <p className="mt-1 text-xs text-negative" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button size="sm" onClick={accept} loading={pending}>
        Accept terms
      </Button>
    </div>
  );
}
