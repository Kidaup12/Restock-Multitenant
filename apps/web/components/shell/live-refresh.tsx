"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtime } from "@/lib/realtime/use-realtime";
import { useRealtimeConnection } from "@/components/realtime-connection";

/**
 * Keeps every page's data current without a manual reload.
 *
 * Only Today used to listen: every other screen showed the data as it was when
 * it was opened, so a sync that landed new stock or a fixed cost was invisible
 * until someone reloaded.
 *
 * - A Shopify sync or POS import finishing re-renders the page's server data in
 *   place (`router.refresh()` keeps client state — filters, ticks, open
 *   panels).
 * - It never refreshes under someone typing: the refresh waits until focus
 *   leaves the field.
 * - A hidden tab doesn't refresh; it catches up when it is looked at again, and
 *   a tab left hidden for a while refreshes on return even if no event arrived
 *   (a socket can drop an event; this is the safety net).
 * - A new FORECAST changes the buy list itself, so rather than swap a plan out
 *   from under someone mid-decision it offers a one-click "Load new plan".
 */

const STALE_AFTER_HIDDEN_MS = 5 * 60_000;

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function LiveRefresh() {
  const router = useRouter();
  const connection = useRealtimeConnection();
  const pending = useRef(false);
  const hiddenAt = useRef<number | null>(null);
  const [newForecast, setNewForecast] = useState(false);

  const flush = useCallback(() => {
    if (!pending.current) return;
    if (document.visibilityState !== "visible" || isTyping()) return;
    pending.current = false;
    router.refresh();
  }, [router]);

  const request = useCallback(() => {
    pending.current = true;
    flush();
  }, [flush]);

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      if (hiddenAt.current != null && Date.now() - hiddenAt.current > STALE_AFTER_HIDDEN_MS) {
        pending.current = true;
      }
      hiddenAt.current = null;
      flush();
    }
    // focusout fires before focus lands elsewhere; wait a tick so a move from
    // one field to the next still counts as typing.
    function onFocusOut() {
      setTimeout(flush, 0);
    }
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [flush]);

  useRealtime(
    {
      "sync.done": (event) => {
        if (event.data.ok) request();
      },
      "pos.ingested": () => request(),
      "forecast.done": () => setNewForecast(true),
    },
    connection
  );

  if (!newForecast) return null;
  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-40 flex items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-ink shadow-pop"
    >
      <span>A new forecast is ready.</span>
      <button
        type="button"
        onClick={() => {
          setNewForecast(false);
          pending.current = false;
          router.refresh();
        }}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
      >
        Load new plan
      </button>
      <button
        type="button"
        onClick={() => setNewForecast(false)}
        aria-label="Dismiss"
        className="text-ink-faint transition-colors hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
