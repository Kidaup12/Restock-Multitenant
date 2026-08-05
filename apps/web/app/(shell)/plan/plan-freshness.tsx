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
  const { tone, text } = freshness;

  if (tone === "neutral") return <p className="text-sm text-ink-muted">{text}</p>;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-warning">{text}</p>
      <RunForecastButton />
    </div>
  );
}
