"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { provisionWorkspaceAction } from "./actions";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";
import { StepUpPrompt } from "./step-up-prompt";

/**
 * Stand up a customer's workspace without a database console.
 *
 * Collapsed by default: the fleet list is what this page is for, and minting
 * workspaces is occasional. Expanded, it says what will happen to the owner —
 * an existing account gets the shop straight away, a new one gets an invite —
 * because those are different conversations to have with the customer.
 */
/**
 * What is still missing, in the order the fields appear.
 *
 * The button used to sit disabled on the same condition and say nothing, so
 * someone who had typed one field — or mistyped an address — got a control that
 * simply refused to respond, with no way to find out why. Pressing it and being
 * told is better than being ignored.
 */
export function whatIsMissing(name: string, ownerEmail: string): string | null {
  if (name.trim().length < 2) return "Give the shop a name of at least two characters.";
  if (ownerEmail.trim().length === 0) return "Enter the owner's email address.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail.trim())) {
    return "That doesn't look like an email address.";
  }
  return null;
}

export function ProvisionForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const router = useRouter();

  function submit() {
    setNote(null);
    const problem = whatIsMissing(name, ownerEmail);
    if (problem) {
      setNote({ tone: "negative", text: problem });
      return;
    }
    startTransition(async () => {
      const body = new FormData();
      body.set("name", name);
      body.set("ownerEmail", ownerEmail);
      const result = await provisionWorkspaceAction(body);
      if (result.ok) {
        setNeedsStepUp(false);
        setNote({ tone: "positive", text: result.message });
        setName("");
        setOwnerEmail("");
        router.refresh();
      } else if (result.error === STEP_UP_REQUIRED) {
        // Not an error to show — the typed name and email stay where they are
        // and the prompt finishes the job.
        setNeedsStepUp(true);
      } else {
        setNote({ tone: "negative", text: result.error });
      }
    });
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Create a workspace
        </Button>
      </div>
    );
  }

  const field = "w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-ink";

  return (
    <Card>
      <CardHeader
        title="Create a workspace"
        subtitle="For a shop that isn't signing up themselves"
        action={
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        }
      />
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-sm text-ink-muted">Shop name</span>
            <input
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Westlands Beauty"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm text-ink-muted">Owner&apos;s email</span>
            <input
              className={field}
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="owner@theirshop.co.ke"
            />
          </label>
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          If they already have an account the shop is theirs immediately. If not, they get an email
          invite and become the owner when they accept it — until then the workspace has no members
          and nobody can open it.
        </p>
        {needsStepUp && (
          <div className="mt-3">
            <StepUpPrompt
              action="create a workspace"
              onConfirmed={() => {
                setNeedsStepUp(false);
                submit();
              }}
              onCancel={() => setNeedsStepUp(false)}
            />
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          {/* Deliberately not disabled: a dead button is what left someone
              pressing it with nothing happening. It presses, and says what is
              still needed. */}
          <Button size="sm" onClick={submit} loading={pending}>
            Create workspace
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
      </CardContent>
    </Card>
  );
}
