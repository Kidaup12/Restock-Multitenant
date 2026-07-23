"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type SyncState =
  | { phase: "idle" }
  | { phase: "done"; text: string; tone: "positive" | "warning" | "negative" };

/**
 * Per-tenant "Sync" trigger. The response is the no-overlap guard's verdict:
 * enqueued:false + the blocking job's state means a sync is already running,
 * which is feedback, not an error.
 */
export function SyncButton({ tenantId }: { tenantId: string }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<SyncState>({ phase: "idle" });

  async function trigger() {
    setBusy(true);
    setState({ phase: "idle" });
    try {
      const res = await fetch("/api/admin/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      const body = (await res.json()) as { enqueued?: boolean; state?: string; error?: string };
      if (!res.ok) {
        setState({ phase: "done", tone: "negative", text: body.error ?? "Failed" });
      } else if (body.enqueued) {
        setState({ phase: "done", tone: "positive", text: "Queued" });
      } else {
        setState({
          phase: "done",
          tone: "warning",
          text: body.state === "active" ? "Already running" : `Already queued (${body.state})`,
        });
      }
    } catch {
      setState({ phase: "done", tone: "negative", text: "Failed" });
    } finally {
      setBusy(false);
    }
  }

  const toneClass = {
    positive: "text-positive",
    warning: "text-warning",
    negative: "text-negative",
  } as const;

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={trigger} loading={busy}>
        Sync
      </Button>
      {state.phase === "done" && (
        <span className={`text-xs font-medium ${toneClass[state.tone]}`}>{state.text}</span>
      )}
    </span>
  );
}
