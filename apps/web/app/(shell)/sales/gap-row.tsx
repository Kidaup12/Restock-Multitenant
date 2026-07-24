"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SalesGapView } from "@/lib/data/pos-queues";
import { dismissGapAction, repullGapAction } from "./actions";

/**
 * One sales-gap row: a branch that recorded zero sales on a day its siblings
 * sold. Two dismissals — "shop was closed" writes a closure the forecast
 * honours, "feed issue" re-pulls that day. Admin-only.
 */
export function GapRow({ gap, canFix }: { gap: SalesGapView; canFix: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, startClose] = useTransition();
  const [repulling, startRepull] = useTransition();

  const close = () => {
    setError(null);
    setMessage(null);
    startClose(async () => {
      const result = await dismissGapAction({ locationId: gap.locationId, dayKey: gap.dayKey });
      if (result.ok) setMessage(result.message ?? "Marked closed.");
      else setError(result.error);
    });
  };

  const repull = () => {
    setError(null);
    setMessage(null);
    startRepull(async () => {
      const result = await repullGapAction();
      if (result.ok) setMessage(result.message ?? "Re-pulling.");
      else setError(result.error);
    });
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-edge px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">
          <span className="font-medium">{gap.locationName}</span> recorded zero sales on {gap.label}
        </p>
        <p className="text-xs text-ink-muted">Was the shop closed, or is the sales feed missing?</p>
      </div>

      {canFix ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={close} loading={closing}>
            Shop was closed
          </Button>
          <Button size="sm" variant="ghost" onClick={repull} loading={repulling}>
            Feed issue — re-pull
          </Button>
        </div>
      ) : (
        <Badge tone="neutral">Ask an admin to resolve</Badge>
      )}

      {message && (
        <p className="w-full text-xs text-positive" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="w-full text-xs text-negative" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
