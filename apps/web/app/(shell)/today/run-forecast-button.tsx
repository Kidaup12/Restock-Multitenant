"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** What a finished run says. A run that changes nothing looked exactly like one
 *  that never fired: the button had a spinner and a failure line but no
 *  confirmation, and the only other signal — "Plan computed 10 Aug" — is
 *  day-granular, so a same-day re-run left every visible figure identical. */
export function forecastRunMessage(created: number | undefined): string {
  if (typeof created !== "number") return "Forecast run";
  return `${created} product${created === 1 ? "" : "s"} updated`;
}

type RunState = { ok: true; text: string } | { ok: false; text: string } | null;

/** Kicks a forecast run, then refreshes the server components so the reorder
 *  table and stock cover pick up the new predictions. */
export function RunForecastButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunState>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/forecast/run", { method: "POST" });
      if (!res.ok) throw new Error(`forecast run: ${res.status}`);
      const body = (await res.json()) as { created?: number };
      router.refresh();
      setResult({ ok: true, text: forecastRunMessage(body.created) });
    } catch {
      setResult({ ok: false, text: "Run failed — try again" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-2" data-tour="today-run-forecast">
      {/* Only after the spinner has gone: a loading Button renders its own
          role="status", and two live regions in one subtree announce over each
          other. */}
      {!running && result?.ok === true && (
        <span role="status" className="text-xs text-positive">
          {result.text}
        </span>
      )}
      {!running && result?.ok === false && (
        <span role="alert" className="text-xs text-negative">
          {result.text}
        </span>
      )}
      <Button loading={running} onClick={run}>
        Run forecast
      </Button>
    </div>
  );
}
