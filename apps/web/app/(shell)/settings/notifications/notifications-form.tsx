"use client";

import { useState, useTransition } from "react";
import {
  OPTIONAL_EMAIL_KINDS,
  OPTIONAL_EMAIL_LABELS,
  type NotifyPrefs,
} from "@wezesha/db/notify-prefs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { saveNotificationPrefs } from "./actions";

/**
 * The member's own switches. Every box is ticked until they untick one — the
 * stored shape carries only what they have said, so "never opened this page"
 * and "wants everything" are the same state and nobody is silenced by default.
 */
export function NotificationsForm({
  initial,
  centralisedTo,
}: {
  initial: NotifyPrefs;
  /** The workspace's alert email, when one is set — see the note it renders. */
  centralisedTo: string | null;
}) {
  const [prefs, setPrefs] = useState<NotifyPrefs>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await saveNotificationPrefs(prefs);
      if (result.ok) setSaved(true);
      else setError(result.error);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      {error && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      <Card>
        <CardHeader
          title="Emails we send you"
          subtitle="Only the messages the app starts on its own. Anything you ask for — an invite, a sign-in code, a purchase order — always sends."
        />
        <CardContent className="space-y-3 pt-4">
          {centralisedTo && (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-secondary">
              This workspace sends its alerts to {centralisedTo} instead of to people
              individually, so these switches won&apos;t change what you receive until that
              address is cleared in Workspace settings.
            </p>
          )}
          {OPTIONAL_EMAIL_KINDS.map((kind) => (
            <label key={kind} className="flex gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-(--accent)"
                checked={prefs[kind] !== false}
                disabled={pending}
                onChange={(e) => {
                  setPrefs((p) => ({ ...p, [kind]: e.target.checked }));
                  setSaved(false);
                }}
              />
              <span>
                <span className="block text-sm text-ink">{OPTIONAL_EMAIL_LABELS[kind].title}</span>
                <span className="block text-xs text-ink-muted">
                  {OPTIONAL_EMAIL_LABELS[kind].body}
                </span>
              </span>
            </label>
          ))}
          <p className="text-xs text-ink-faint">
            Switching one off stops the email, not the record — it still shows in your
            notifications.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>
          Save
        </Button>
        {saved && <span className="text-sm text-positive">Saved.</span>}
      </div>
    </form>
  );
}
