"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { forecastRunMessage } from "./run-forecast-button";

/**
 * Sync and Run forecast, behind one quiet control.
 *
 * They were a filled accent button at the top of the dashboard — the most
 * prominent thing on the screen, competing with the numbers it exists to
 * produce. Neither is a daily job: the forecast runs nightly and after every
 * sync, and the sync runs on its own schedule. A shop that presses these often
 * has a problem the buttons will not fix.
 *
 * They stay reachable because when they ARE needed — a store just connected, a
 * cost just corrected — waiting for the next cron is the wrong answer.
 *
 * A <details> rather than hand-rolled state: it closes on Escape, is keyboard
 * reachable, and needs no outside-click listener of its own.
 */
export function AdvancedMenu() {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "sync" | "forecast">(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(which: "sync" | "forecast") {
    setBusy(which);
    setNote(null);
    try {
      if (which === "forecast") {
        const res = await fetch("/api/forecast/run", { method: "POST" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { created?: number };
        setNote({ ok: true, text: forecastRunMessage(body.created) });
      } else {
        const res = await fetch("/api/shopify/sync", { method: "POST" });
        const body = (await res.json()) as { enqueued?: boolean; error?: string };
        if (!res.ok) throw new Error(body.error ?? String(res.status));
        // The no-overlap guard means "already running" is a normal answer, not
        // a failure — saying "started" either way would be a small lie.
        setNote({ ok: true, text: body.enqueued ? "Sync started." : "A sync is already running." });
      }
      router.refresh();
    } catch (err) {
      setNote({ ok: false, text: which === "sync" ? "Could not start the sync." : "Run failed — try again." });
      void err;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <details className="relative">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-2 hover:text-ink">
          <span aria-hidden>···</span>
          Advanced
        </summary>
        <div className="absolute right-0 z-10 mt-1 flex min-w-48 flex-col rounded-lg border border-edge bg-surface p-1 shadow-pop">
          <button
            type="button"
            onClick={() => run("sync")}
            disabled={busy !== null}
            className="rounded-md px-2.5 py-1.5 text-left text-sm text-ink-secondary hover:bg-surface-2 hover:text-ink disabled:opacity-60"
          >
            {busy === "sync" ? "Starting…" : "Sync now"}
          </button>
          <button
            type="button"
            onClick={() => run("forecast")}
            disabled={busy !== null}
            className="rounded-md px-2.5 py-1.5 text-left text-sm text-ink-secondary hover:bg-surface-2 hover:text-ink disabled:opacity-60"
          >
            {busy === "forecast" ? "Running…" : "Run forecast"}
          </button>
        </div>
      </details>
      {note && (
        <span role="status" className={note.ok ? "text-2xs text-positive" : "text-2xs text-negative"}>
          {note.text}
        </span>
      )}
    </div>
  );
}
