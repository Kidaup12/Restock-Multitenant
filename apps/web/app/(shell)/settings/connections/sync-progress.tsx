"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Progress } from "@/components/ui/progress";
import { useRealtime, useRealtimeStatus } from "@/lib/realtime/use-realtime";
import { useRealtimeConnection } from "@/components/realtime-connection";
import type { SyncRunView } from "@/lib/shopify/sync-run";

/**
 * Live view of the sync the worker is running.
 *
 * Seeded from the server-rendered row, so it is already correct before any
 * socket opens — that is what a reload mid-run, a second tab, and the redirect
 * straight after connecting a store all depend on. Realtime and polling only
 * keep it fresh; neither is required for it to be right.
 */

const PHASE_LABEL: Record<string, string> = {
  products: "Products",
  inventory: "Stock and branches",
  orders: "Sales history",
};

const PHASE_FETCHING: Record<string, string> = {
  products: "Fetching products from Shopify…",
  inventory: "Fetching stock levels from Shopify…",
  orders: "Fetching sales history from Shopify…",
};

const PHASE_UNIT: Record<string, string> = {
  products: "products",
  inventory: "branches",
  orders: "sales days",
};

/** How often to ask the server when the socket is not carrying events. */
const POLL_MS = 5000;

/** How long a job may sit between "queued" and the worker opening its run
 *  before we stop implying something is happening. A worker that is restarting,
 *  mid-deploy, or simply down otherwise leaves this spinning for ever. */
const QUEUE_GRACE_MS = 45_000;

export function SyncProgress({
  initialRun,
  /** True between pressing Sync now and the worker picking the job up — the one
   *  window where no row exists yet. */
  queued,
  /** Increments on each enqueue, so a fresh attempt clears a previous give-up. */
  queueAttempt,
  /** Whether a sync is genuinely in flight. The card disables "Sync now" on it,
   *  and only this component can tell — the card's row prop is a server render
   *  and does not move while a sync progresses. */
  onActiveChange,
  /** A run reached a terminal state; the card clears its queued flag, and uses
   *  the status to decide whether any standing complaint is now obsolete. */
  onSettled,
}: {
  initialRun: SyncRunView | null;
  queued: boolean;
  queueAttempt: number;
  onActiveChange: (active: boolean) => void;
  onSettled: (status?: SyncRunView["status"]) => void;
}) {
  const router = useRouter();
  const [run, setRun] = useState<SyncRunView | null>(initialRun);
  // Shared with the shell's other realtime consumers — one binding per shell.
  const connection = useRealtimeConnection();
  // The server prop is authoritative whenever it actually changes — which is
  // after the router.refresh() on sync.done. Adopting it during render (rather
  // than in an effect) means the final state paints in the same pass.
  const propKey = initialRun
    ? `${initialRun.id}:${initialRun.status}:${initialRun.phase}:${initialRun.itemsDone}`
    : "none";
  const [seenProp, setSeenProp] = useState(propKey);
  if (propKey !== seenProp) {
    setSeenProp(propKey);
    setRun(initialRun);
  }


  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/shopify/sync-status");
      if (!res.ok) return;
      const data = (await res.json()) as { run: SyncRunView | null };
      setRun(data.run);
      // With no socket, polling is the only thing that will ever notice a run
      // ending — so it has to release the queued flag too.
      if (data.run && data.run.status !== "running") onSettled(data.run.status);
    } catch {
      // Transient — the next tick tries again.
    }
  }, [onSettled]);

  useRealtime(
    {
      "sync.progress": (event) => {
        const d = event.data;
        if (d.source !== "shopify") return;
        // A run that starts after this page loaded simply takes over: adopting
        // the newer id beats ignoring events for a run we haven't heard of.
        setRun((prev) => ({
          id: d.runId ?? prev?.id ?? "",
          status: "running",
          phase: d.phase,
          phaseIndex: d.state === "finished" ? d.done : d.done + 1,
          phaseTotal: d.total,
          itemsDone: d.items ?? 0,
          itemsTotal: d.itemsTotal ?? null,
          summary: prev?.summary ?? null,
          error: null,
          finishedAt: null,
          durationSec: null,
        }));
      },
      "sync.done": (event) => {
        if (event.data.source !== "shopify") return;
        // Re-read the row for the authoritative ending — counts, error text —
        // and refresh the route so the "Last sync" timestamps update too.
        onSettled();
        void refetch();
        router.refresh();
      },
    },
    connection
  );

  const socket = useRealtimeStatus(connection);
  const running = run?.status === "running";
  const waitingForWorker = queued && !running;

  // Nothing picks the job up if the worker is restarting or down, and the queue
  // cannot tell us that. Time the wait out rather than imply progress for ever.
  // Sticky, so the warning survives; a fresh attempt clears it.
  const [gaveUp, setGaveUp] = useState(false);
  const [seenAttempt, setSeenAttempt] = useState(queueAttempt);
  if (queueAttempt !== seenAttempt) {
    setSeenAttempt(queueAttempt);
    setGaveUp(false);
  }
  useEffect(() => {
    if (!waitingForWorker || gaveUp) return;
    const timer = setTimeout(() => setGaveUp(true), QUEUE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [waitingForWorker, gaveUp]);

  const active = running || (waitingForWorker && !gaveUp);
  const poll = active || queued;
  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  // Polling is load-bearing, not a nicety: with no gateway configured the socket
  // never opens, and progress would be the same silence as before.
  useEffect(() => {
    if (!poll || socket === "open") return;
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll, socket, refetch]);

  // Nothing picked the job up. Said plainly, and outside the queued check, so
  // the message survives the card releasing its flag.
  if (gaveUp && !running) {
    return (
      <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        The sync is queued but nothing has picked it up yet. The background worker may be
        restarting — this page will update on its own once it does.
      </p>
    );
  }

  // While queued, any row still on screen belongs to the PREVIOUS run — showing
  // its finish time would read as though the new sync had already completed.
  if (waitingForWorker) {
    return <p className="text-sm text-ink-muted">Queued — waiting for the sync to start…</p>;
  }
  if (!run) return null;

  if (run.status === "running") {
    const phase = run.phase ?? "products";
    const known = run.itemsTotal != null && run.itemsTotal > 0;
    return (
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-4 text-sm">
          <span className="font-medium text-ink">
            {PHASE_LABEL[phase] ?? phase}
            <span className="ml-2 text-ink-muted">
              step {Math.max(1, run.phaseIndex)} of {run.phaseTotal || 3}
            </span>
          </span>
          <span className="text-ink-muted">
            {known
              ? `${run.itemsDone.toLocaleString("en-KE")} of ${run.itemsTotal!.toLocaleString("en-KE")} ${PHASE_UNIT[phase] ?? "records"}`
              : (PHASE_FETCHING[phase] ?? "Working…")}
          </span>
        </div>
        <Progress
          value={run.itemsDone}
          max={known ? run.itemsTotal : null}
          label={`Sync progress — ${PHASE_LABEL[phase] ?? phase}`}
        />
      </div>
    );
  }

  if (run.status === "stalled") {
    return (
      <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        This sync stopped responding and may not have finished. Try running it again.
      </p>
    );
  }

  if (run.status === "failed") {
    return (
      <p className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
        Last sync failed{run.error ? `: ${run.error}` : "."}
      </p>
    );
  }

  return (
    <p className="text-sm text-ink-muted">
      Last sync finished{run.finishedAt ? ` ${run.finishedAt}` : ""}
      {run.summary ? ` · ${run.summary}` : ""}
      {run.durationSec != null ? ` · took ${formatDuration(run.durationSec)}` : ""}
    </p>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${mins}m` : `${mins}m ${rest}s`;
}
