"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTransferPlan } from "./actions";

/**
 * Save the proposal on screen as a draft plan. Only the source and horizon are
 * submitted — the action re-sizes server-side, so nothing a client edits can
 * become a stored quantity.
 */
export function SavePlanBar({
  fromLocationId,
  fromLocationName,
  coverDays,
  canPlan,
}: {
  fromLocationId: string;
  fromLocationName: string;
  coverDays: number;
  canPlan: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!canPlan) {
    return <p className="text-sm text-ink-muted">Ask someone with ordering access to save this plan.</p>;
  }

  function save() {
    setError(null);
    start(async () => {
      const result = await createTransferPlan({
        fromLocationId,
        coverDays,
        name: name.trim() || `${fromLocationName} · ${coverDays}d cover`,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && <span className="text-sm text-negative">{error}</span>}
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name this plan (optional)"
        className="min-h-8 w-56 text-xs"
      />
      <Button size="sm" loading={pending} onClick={save}>
        Save plan
      </Button>
    </div>
  );
}
