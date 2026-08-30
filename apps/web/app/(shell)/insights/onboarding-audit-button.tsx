"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Re-tune the forecast to how this shop actually sells, on demand.
 *
 * The audit replays the shop's own sales history and, where the numbers support
 * it, moves the forecast onto the routing that fits that shop best. It runs a
 * nested backtest on the engine, so it is slower than the local accuracy check
 * — the pending copy says so, rather than looking hung.
 *
 * Nothing engine-internal reaches here: the route returns only whether it ran,
 * whether it changed anything, and a neutral reason. This renders sentences off
 * those three facts and never a tier, method or model.
 */
export function OnboardingAuditButton({ canRun }: { canRun: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  if (!canRun) return null;

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/forecast/onboarding-audit", { method: "POST" });
      const body = (await res.json()) as {
        ran?: boolean;
        changed?: boolean;
        reason?: string | null;
        error?: string;
      };
      if (!res.ok) {
        setNote({ tone: "err", text: "Couldn't run the check right now — please try again in a moment." });
      } else if (body.ran) {
        setNote({
          tone: "ok",
          text: "We tuned your forecast to how your shop actually sells.",
        });
        router.refresh();
      } else if (body.reason === "insufficient_history") {
        // Not a failure: a young shop simply hasn't sold long enough to tune to.
        setNote({
          tone: "err",
          text: "Not enough sales history yet — check back once you've been selling a bit longer.",
        });
      } else if (body.reason === "engine_halted") {
        setNote({
          tone: "err",
          text: "Your sales data isn't clean enough to tune the forecast yet.",
        });
      } else {
        // engine_failed / engine_unreachable / anything else: a transient miss.
        setNote({
          tone: "err",
          text: "Couldn't run the check right now — please try again in a moment.",
        });
      }
    } catch {
      setNote({ tone: "err", text: "Couldn't run the check right now — please try again in a moment." });
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
        {busy ? "Checking your sales history…" : "Tune to my shop"}
      </Button>
    </div>
  );
}
