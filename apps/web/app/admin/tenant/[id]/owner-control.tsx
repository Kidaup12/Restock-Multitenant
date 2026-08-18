"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inviteWorkspaceOwner } from "@/app/admin/actions";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";
import { StepUpPrompt } from "@/app/admin/step-up-prompt";

/**
 * Invite a second owner to an existing workspace.
 *
 * The workspace's own team screen caps every invite at MEMBER on purpose — an
 * owner able to mint owners could hand out their own access — so ownership is
 * granted here, by an operator, behind the same password re-entry the tier
 * change asks for. Nothing in the in-workspace guards changes.
 */
export function OwnerControl({ tenantId }: { tenantId: string }) {
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const router = useRouter();

  function send() {
    setNote(null);
    startTransition(async () => {
      const body = new FormData();
      body.set("tenantId", tenantId);
      body.set("email", email);
      const result = await inviteWorkspaceOwner(body);
      if (result.ok) {
        setNeedsStepUp(false);
        setEmail("");
        setNote({ tone: "positive", text: `Owner invite sent to ${result.email}.` });
        router.refresh();
      } else if (result.error === STEP_UP_REQUIRED) {
        // The typed address survives; confirming carries straight on to sending.
        setNeedsStepUp(true);
      } else {
        setNote({ tone: "negative", text: result.error });
      }
    });
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="owner-email" className="text-2xs font-medium tracking-wider text-ink-muted uppercase">
          Email
        </label>
        <Input
          id="owner-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && email.trim() && send()}
          placeholder="them@theirshop.com"
          className="max-w-xs"
          autoComplete="off"
          name="admin-owner-email"
        />
        <Button size="sm" onClick={send} loading={pending} disabled={pending || !email.trim()}>
          Invite as owner
        </Button>
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
      </div>
      {needsStepUp && (
        <StepUpPrompt
          action="invite an owner to this workspace"
          onConfirmed={() => {
            setNeedsStepUp(false);
            send();
          }}
          onCancel={() => setNeedsStepUp(false)}
        />
      )}
      <p className="text-xs text-ink-muted">
        An owner sees costs and margins, manages the team and settings, and can export or delete the
        workspace. The invite expires in seven days and is written to the audit trail. A workspace
        can hold more than one owner; the last one cannot be removed.
      </p>
    </div>
  );
}
