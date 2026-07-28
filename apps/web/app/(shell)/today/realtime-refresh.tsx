"use client";

import { useRouter } from "next/navigation";
import { useRealtime } from "@/lib/realtime/use-realtime";
import { useRealtimeConnection } from "@/components/realtime-connection";

/**
 * Invisible bridge: subscribes to this workspace's realtime channel and
 * re-renders the page's server components when a forecast or sync completes.
 * Renders nothing; SSR-safe, since the shared binding starts null and the hooks
 * stay idle until it resolves.
 */
export function RealtimeRefresh() {
  const router = useRouter();
  const connection = useRealtimeConnection();

  useRealtime(
    {
      "forecast.done": () => router.refresh(),
      "sync.done": () => router.refresh(),
    },
    connection
  );

  return null;
}
