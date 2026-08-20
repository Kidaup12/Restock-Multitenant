"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Score the forecast now, rather than waiting for the first of the month.
 *
 * The walk-forward check has always run monthly on the worker, and that was the
 * only way it ever ran — so "how accurate is the forecast?" could only be
 * answered with a figure up to a month old, and a shop that had just connected
 * could not answer it at all. Every other number on this page is same-day; this
 * one was not.
 *
 * Scoring replays past sales and re-forecasts against them. It writes a grade
 * and touches nothing a shop acts on — no predictions, no orders, no stock.
 */
export function RunBacktestButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/forecast/backtest", { method: "POST" });
      const body = (await res.json()) as {
        rowsWritten?: number;
        scored?: { saidUnits: number; happenedUnits: number; sampleSize: number } | null;
        error?: string;
      };
      if (!res.ok) {
        setNote({ tone: "err", text: body.error ?? "The check could not run." });
      } else if (!body.rowsWritten) {
        // Not a failure: a shop with too little history has nothing to replay.
        setNote({
          tone: "err",
          text: "Not enough sales history to replay yet — the check needs a stretch of past sales to forecast against.",
        });
      } else {
        setNote({
          tone: "ok",
          text: body.scored
            ? `Checked ${body.scored.sampleSize} product windows: we said ${Math.round(body.scored.saidUnits)}, you sold ${Math.round(body.scored.happenedUnits)}.`
            : "Check complete.",
        });
        router.refresh();
      }
    } catch {
      setNote({ tone: "err", text: "The check could not run." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {note && (
        <span
          role="status"
          className={`text-xs ${note.tone === "ok" ? "text-positive" : "text-ink-muted"}`}
        >
          {note.text}
        </span>
      )}
      <Button size="sm" variant="ghost" onClick={() => void run()} loading={busy}>
        Check now
      </Button>
    </div>
  );
}
