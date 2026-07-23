"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtime } from "@/lib/realtime/use-realtime";

type Connection = { url: string | null; token: string | null };

/**
 * Invisible bridge: subscribes to this workspace's realtime channel and
 * re-renders the page's server components when a forecast or sync completes.
 * Renders nothing; SSR-safe (no socket until the token fetch resolves in an
 * effect, and the hooks stay idle while url/token are null).
 */
export function RealtimeRefresh() {
  const router = useRouter();
  const [connection, setConnection] = useState<Connection>({ url: null, token: null });

  useEffect(() => {
    let alive = true;
    fetch("/api/realtime-token")
      .then((res) => (res.ok ? (res.json() as Promise<Connection>) : null))
      .then((data) => {
        if (alive && data) setConnection(data);
      })
      .catch(() => {
        // No realtime — the screen still works, just without live refresh.
      });
    return () => {
      alive = false;
    };
  }, []);

  useRealtime(
    {
      "forecast.done": () => router.refresh(),
      "sync.done": () => router.refresh(),
    },
    connection
  );

  return null;
}
