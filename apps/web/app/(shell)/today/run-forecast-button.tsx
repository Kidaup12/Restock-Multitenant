"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Kicks a forecast run, then refreshes the server components so the reorder
 *  table and stock cover pick up the new predictions. */
export function RunForecastButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    setRunning(true);
    setFailed(false);
    try {
      const res = await fetch("/api/forecast/run", { method: "POST" });
      if (!res.ok) throw new Error(`forecast run: ${res.status}`);
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {failed && <span className="text-xs text-negative">Run failed — try again</span>}
      <Button loading={running} onClick={run}>
        Run forecast
      </Button>
    </div>
  );
}
