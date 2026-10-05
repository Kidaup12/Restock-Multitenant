"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { SpikeSuggestion } from "@/lib/data/signals";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { dismissSpike, logSpikeAsPromo, type SignalActionResult } from "./actions";

/**
 * "Was this a promo?" — the days the shop sold far above its own normal with
 * nothing logged to explain them.
 *
 * Asked, never assumed: only the owner can explain whether unusual sales came
 * from an offer or a bulk buyer. A dismissal acknowledges evidence without
 * changing demand; recorded promotions follow the shop's forecast settings.
 */
export function SpikeSuggestions({
  suggestions,
  canManage,
  reviewLink = true,
  limit = 5,
}: {
  suggestions: SpikeSuggestion[];
  canManage: boolean;
  reviewLink?: boolean;
  limit?: number;
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
      try {
        const input = { productId: s.productId, dayKey: s.dayKey };
        const result = asPromo ? await logSpikeAsPromo(input) : await dismissSpike(input);
        setNote(result);
        if (result.ok) setAnswered((prev) => new Set(prev).add(`${s.productId}:${s.dayKey}`));
      } catch {
        setNote({ ok: false, error: "Couldn't save your review. Please try again." });
      }
    });
  }

  return (
    <Card>
      <CardHeader
        title="Unusual sales to review"
        subtitle={`${open.length} unreviewed ${open.length === 1 ? "day" : "days"} · showing up to ${limit} most recent flags from the last year`}
        action={reviewLink ? <Link href="/sales#unusual-sales" className="text-sm underline">Review sales flags</Link> : undefined}
      />
      <CardContent className="space-y-3 pt-0">
        <p className="text-sm text-ink-secondary">
          A large daily total may be a bulk purchase, an offer, or several ordinary orders.
          These flags do not identify a single buyer. Record a real promotion or dismiss a reviewed
          flag. Dismissing only clears the prompt; it does not change sales or forecast demand.
        </p>
        <p className="text-sm text-ink-muted">Possible bulk days exceed both six units and five times the median positive sales day. Broader unusual-day flags use the existing three-times baseline rule. {canManage && <Link href="/settings/ordering-strategy" className="underline">Review bulk-purchase protection in forecast settings.</Link>}</p>
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
                <Link href={`/products/${encodeURIComponent(s.productId)}`} className="block truncate font-medium text-ink hover:underline">{s.title}</Link>
                <span className="block text-xs font-medium text-ink">{s.kind === "possible_bulk" ? "Possible bulk purchase" : "Unusual sales day"}</span>
                <span className="block text-sm text-ink-muted">
                  {s.dayLabel}{s.inProgress ? " (today so far)" : ""} · {s.quantity} units across all channels · typical selling day {s.baseline} units · {s.multiple}×
                </span>
              </span>
              {canManage && (
                <span className="flex shrink-0 items-center gap-2">
                  <Button size="sm" loading={pending} disabled={pending} onClick={() => answer(s, true)}>
                    Record promotion
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => answer(s, false)}
                  >
                    Dismiss flag
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
