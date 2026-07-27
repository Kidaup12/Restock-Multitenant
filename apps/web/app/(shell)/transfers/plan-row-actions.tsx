"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { discardTransferPlan, finaliseTransferPlan } from "./actions";

/** Finalise or drop a saved plan. Both actions re-check the permission and the
 *  plan tier server-side; these buttons only choose which one to call. */
export function PlanRowActions({ planId, status }: { planId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => () => {
    setError(null);
    start(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      {status === "draft" && (
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
          onClick={run(() => finaliseTransferPlan({ planId }))}
        >
          Finalise
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        loading={pending}
        onClick={run(() => discardTransferPlan({ planId }))}
      >
        Discard
      </Button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
