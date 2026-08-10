"use client";

import { useState, useTransition } from "react";
import type { SpikeSuggestion } from "@/lib/data/signals";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { dismissSpike, logSpikeAsPromo, type SignalActionResult } from "./actions";

/**
 * "Was this a promo?" — the days the shop sold far above its own normal with
 * nothing logged to explain them.
 *
 * Asked, never assumed: only the owner knows whether a 3× day was a promotion
 * or a single bulk buyer, and the two want opposite treatment. Answering keeps
 * the day out of the normal sales rate; declining is remembered so the same day
 * isn't raised again.
 */
export function SpikeSuggestions({
  suggestions,
  canManage,
}: {
  suggestions: SpikeSuggestion[];
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<SignalActionResult | null>(null);
  // Answered rows leave immediately — the list is a short nudge, and waiting for
  // the revalidate to land makes it feel like the click missed.
  const [answered, setAnswered] = useState<Set<string>>(new Set());

  const open = suggestions.filter((s) => !answered.has(`${s.productId}:${s.dayKey}`));
  if (open.length === 0) return null;

  function answer(s: SpikeSuggestion, asPromo: boolean) {
    setNote(null);
    start(async () => {
      const input = { productId: s.productId, dayKey: s.dayKey };
      const result = asPromo ? await logSpikeAsPromo(input) : await dismissSpike(input);
      setNote(result);
      if (result.ok) setAnswered((prev) => new Set(prev).add(`${s.productId}:${s.dayKey}`));
    });
  }

  return (
    <Card>
      <CardHeader
        title="Was this a promotion?"
        subtitle={`${open.length} unusual sales ${open.length === 1 ? "day" : "days"} with nothing logged against ${open.length === 1 ? "it" : "them"}`}
      />
      <CardContent className="space-y-3 pt-0">
        <p className="text-sm text-ink-secondary">
          These days sold far above what the product normally does. If it was an offer, saying so
          takes the day out of your normal sales rate — otherwise it quietly inflates every order
          for that product from now on.
        </p>
        {note && (
          <p
            role={note.ok ? "status" : "alert"}
            className={note.ok ? "text-sm text-positive" : "text-sm text-negative"}
          >
            {note.ok ? note.message : note.error}
          </p>
        )}
        <ul className="divide-y divide-edge">
          {open.map((s) => (
            <li
              key={`${s.productId}:${s.dayKey}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{s.title}</span>
                <span className="block text-sm text-ink-muted">
                  {s.dayLabel} · sold {s.quantity} against about {s.baseline} a day · {s.multiple}×
                  normal
                </span>
              </span>
              {canManage && (
                <span className="flex shrink-0 items-center gap-2">
                  <Button size="sm" disabled={pending} onClick={() => answer(s, true)}>
                    Yes, it was an offer
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => answer(s, false)}
                  >
                    No, one-off
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
