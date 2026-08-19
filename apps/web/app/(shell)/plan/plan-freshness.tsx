"use client";

import { RunForecastButton } from "../today/run-forecast-button";
import type { PlanFreshness as Freshness } from "@/lib/data/forecast-freshness";

/** When the plan was computed, said in every mode rather than only on the choose
 *  screen. A stale plan carries the way out with it — a warning the owner cannot
 *  act on is just a worry.
 *
 *  Takes the verdict, not the clock: this renders on the client, and a browser
 *  clock would decide freshness differently from the server that rendered it. */
export function PlanFreshness({ freshness }: { freshness: Freshness }) {
  const { tone, text, relative } = freshness;

  if (tone === "neutral") {
    // A pill, not a sentence: when the answer is "it is current", the reader
    // wants to confirm it in one glance and move on.
    return (
      <div className="flex items-center justify-end">
        <span
          className="flex items-center gap-1.5 rounded-sm border border-edge bg-surface px-2.5 py-1 text-2xs text-ink-muted"
          title={text}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-positive" />
          Forecast <span className="font-mono tabular-nums">{relative}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-warning">
        <span aria-hidden className="mr-1.5 inline-block size-1.5 rounded-full bg-warning align-middle" />
        {text} <span className="font-mono tabular-nums">({relative})</span>
      </p>
      <RunForecastButton />
    </div>
  );
}
