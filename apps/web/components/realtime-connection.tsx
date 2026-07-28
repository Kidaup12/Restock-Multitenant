"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * One realtime binding for the whole shell.
 *
 * The token names the socket URL and authorises the caller's tenant channel.
 * Three components want it — the notification bell, Today's live refresh and
 * the sync-progress card — and each used to fetch it for itself, so every page
 * load made three authenticated round trips for the same answer.
 *
 * Fetching here also fixes a subtler thing: the token encodes the ACTIVE
 * workspace, and switching workspace is a router.refresh() rather than a
 * remount, so a per-component fetch that ran once on mount kept handing out a
 * binding for the workspace the user had left.
 *
 * A missing or failed token is not an error: realtime is an accelerator here,
 * and every consumer is built to work without it.
 */

export type RealtimeConnection = { url: string | null; token: string | null };

const EMPTY: RealtimeConnection = { url: null, token: null };

const RealtimeConnectionContext = createContext<RealtimeConnection>(EMPTY);

export function RealtimeConnectionProvider({
  workspaceId,
  children,
}: {
  /** Re-binds when the active workspace changes. */
  workspaceId: string | null;
  children: React.ReactNode;
}) {
  // The workspace the stored binding belongs to is kept WITH it, so a switch
  // hands out nothing rather than the previous workspace's token while the new
  // one is still in flight.
  const [bound, setBound] = useState<{ workspaceId: string; connection: RealtimeConnection } | null>(
    null
  );

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    fetch("/api/realtime-token")
      .then((res) => (res.ok ? (res.json() as Promise<RealtimeConnection>) : null))
      .then((data) => {
        if (alive && data) setBound({ workspaceId, connection: data });
      })
      .catch(() => {
        // No realtime configured or reachable — consumers fall back to their
        // server-rendered state and polling.
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const value = bound && bound.workspaceId === workspaceId ? bound.connection : EMPTY;

  return (
    <RealtimeConnectionContext.Provider value={value}>{children}</RealtimeConnectionContext.Provider>
  );
}

export function useRealtimeConnection(): RealtimeConnection {
  return useContext(RealtimeConnectionContext);
}
