"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createWorkspaceAction } from "./actions";

/** Name-only create form. On success the action redirects into the new
 *  workspace, so there is no success state to render here. */
export function NewWorkspaceForm({ nameMaxLength }: { nameMaxLength: number }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createWorkspaceAction(name);
      setError(result.error);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <p
          role="alert"
          className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative"
        >
          {error}
        </p>
      )}

      <Field label="Workspace name" htmlFor="workspace-name">
        <Input
          id="workspace-name"
          autoFocus
          required
          maxLength={nameMaxLength}
          placeholder="e.g. Westlands Shop"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <Button type="submit" loading={pending} className="w-full">
        Create workspace
      </Button>

      <p className="text-xs text-ink-muted">
        You&apos;ll be the owner. Invite the rest of your team from Settings once
        you&apos;re in.
      </p>
    </form>
  );
}
