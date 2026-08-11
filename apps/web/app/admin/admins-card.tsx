"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";
import type { AdminMutationResult, PlatformAdminRow } from "@/lib/admin/admins";
import { grantPlatformAdminAction, revokePlatformAdminAction } from "./actions";
import { StepUpPrompt } from "./step-up-prompt";

/**
 * Who can open this console, changed from inside it.
 *
 * Revoked rows stay listed rather than disappearing: "who used to have access,
 * and who took it away" is the question this table exists to answer, and a row
 * that vanishes answers nothing.
 */

const dateLabel = (d: Date | string): string =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function AdminsCard({ admins }: { admins: PlatformAdminRow[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  /** The action to re-run once the password is confirmed, and what to call it in
   *  the prompt. Held rather than re-derived so confirming resumes exactly the
   *  grant or revoke that asked for it. */
  const [pendingStepUp, setPendingStepUp] = useState<{
    label: string;
    run: () => Promise<AdminMutationResult>;
  } | null>(null);

  function run(label: string, action: () => Promise<AdminMutationResult>) {
    setNote(null);
    setPendingStepUp(null);
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        setNote({ tone: "positive", text: res.message ?? "Done." });
        setEmail("");
        router.refresh();
      } else if (res.error === STEP_UP_REQUIRED) {
        setPendingStepUp({ label, run: action });
      } else {
        setNote({ tone: "negative", text: res.error ?? "That didn't work." });
      }
    });
  }

  function grant() {
    const form = new FormData();
    form.set("email", email);
    run("grant console access", () => grantPlatformAdminAction(form));
  }

  function revoke(userId: string, who: string) {
    if (!confirm(`Remove console access for ${who}? They keep any workspace membership.`)) return;
    const form = new FormData();
    form.set("userId", userId);
    run(`revoke ${who}'s access`, () => revokePlatformAdminAction(form));
  }

  const live = admins.filter((a) => a.revokedAt === null);

  return (
    <Card>
      <CardHeader
        title="Console access"
        subtitle={`${live.length} ${live.length === 1 ? "person" : "people"} can open this console`}
      />
      <CardContent className="space-y-4">
        <div className="overflow-x-auto rounded-md border border-edge">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left">Admin</th>
                <th className="px-3 py-2 text-left">Granted</th>
                <th className="px-3 py-2 text-left">By</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.userId} className="border-t border-edge">
                  <td className="px-3 py-2">
                    <span className="text-ink">{a.name ?? a.email}</span>
                    <span className="ml-2 text-xs text-ink-muted">{a.email}</span>
                    {a.isSelf && (
                      <Badge tone="neutral" className="ml-2">
                        You
                      </Badge>
                    )}
                    {a.revokedAt && (
                      <Badge tone="warning" className="ml-2">
                        revoked {dateLabel(a.revokedAt)}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{dateLabel(a.grantedAt)}</td>
                  <td className="px-3 py-2 text-ink-muted">
                    {a.seeded ? "bootstrap" : (a.grantedByEmail ?? "—")}
                    {a.revokedByEmail && (
                      <span className="block text-xs">revoked by {a.revokedByEmail}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {a.revokedAt === null && !a.isSelf && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => revoke(a.userId, a.email)}
                        disabled={pending}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="email"
            value={email}
            placeholder="person@company.com"
            onChange={(e) => setEmail(e.target.value)}
            className="h-9 w-64 text-sm"
            aria-label="Email to grant console access"
          />
          <Button size="sm" onClick={grant} loading={pending} disabled={!email.trim()}>
            Grant access
          </Button>
          <p className="text-xs text-ink-muted">
            They need to have signed in at least once. You can&apos;t revoke your own access, or the
            last admin&apos;s.
          </p>
        </div>

        {pendingStepUp && (
          <StepUpPrompt
            action={pendingStepUp.label}
            onConfirmed={() => {
              const retry = pendingStepUp.run;
              setPendingStepUp(null);
              run(pendingStepUp.label, retry);
            }}
            onCancel={() => setPendingStepUp(null)}
          />
        )}
        {note && (
          <p
            role={note.tone === "negative" ? "alert" : undefined}
            className={`text-sm ${note.tone === "negative" ? "text-negative" : "text-positive"}`}
          >
            {note.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
