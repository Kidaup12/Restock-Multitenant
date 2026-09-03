"use client";

import { useState } from "react";
import { resetGuides } from "@/lib/guides";

/**
 * Bring the page explainers back.
 *
 * They shipped with no way back at all: one "Got it" writes a workspace-wide
 * flag that silences the whole set, permanently, for that browser. A shop that
 * dismissed them on day one and hires someone in month three had no route to
 * the explanation — and the reset function existed the whole time with nothing
 * calling it, which is worse than not having written it.
 */
export function ResetGuides({ scope }: { scope: string }) {
  const [done, setDone] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => {
          try {
            resetGuides(localStorage, scope);
            setDone(true);
          } catch {
            // Site data blocked: nothing was remembered, so there is nothing to
            // forget and the explainers are already showing.
            setDone(true);
          }
        }}
        className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
      >
        Show page explainers again
      </button>
      {done && (
        <span role="status" className="text-sm text-positive">
          They will appear on your next visit to each page.
        </span>
      )}
    </div>
  );
}
