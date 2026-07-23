"use client";

/**
 * React bindings for the realtime client.
 *
 * Url and token are explicit parameters — the auth layer owns where they come
 * from and passes them in; nothing here assumes a context or session store.
 * While either is missing the hooks stay idle: no socket, status "closed".
 *
 * Hook instances sharing the same url+token share one underlying connection
 * through a refcounted registry, so the status badge and any number of event
 * subscribers cost a single socket. The connection closes when the last hook
 * using it unmounts.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  connect,
  REALTIME_EVENT_TYPES,
  type ConnectionState,
  type RealtimeClient,
  type RealtimeEnvelopeOf,
  type RealtimeEventType,
} from "@wezesha/realtime/client";

export type { ConnectionState, RealtimeEnvelopeOf, RealtimeEventType };

/** One optional handler per event type; each receives its narrowed envelope. */
export type RealtimeHandlers = {
  [K in RealtimeEventType]?: (envelope: RealtimeEnvelopeOf<K>) => void;
};

export interface RealtimeConnection {
  /** ws-gateway origin (ws:// or wss://). Null/undefined → hook stays idle. */
  url: string | null | undefined;
  /** Gateway session token. Null/undefined → hook stays idle. */
  token: string | null | undefined;
}

// --- shared connection registry ----------------------------------------------

interface RegistryEntry {
  client: RealtimeClient;
  refs: number;
  reap: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, RegistryEntry>();

function acquire(url: string, token: string): { client: RealtimeClient; release: () => void } {
  const key = `${url}\n${token}`;
  let entry = registry.get(key);
  if (entry?.client.state === "closed") {
    // Terminal client (auth-rejected). Drop it so a re-acquire reconnects.
    registry.delete(key);
    entry = undefined;
  }
  if (entry) {
    if (entry.reap !== null) {
      clearTimeout(entry.reap);
      entry.reap = null;
    }
  } else {
    entry = { client: connect(url, token), refs: 0, reap: null };
    registry.set(key, entry);
  }
  const held = entry;
  held.refs += 1;
  let released = false;
  return {
    client: held.client,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      // Deferred teardown so an immediate remount (strict mode) reuses the
      // socket instead of closing and reopening it.
      held.reap = setTimeout(() => {
        if (held.refs > 0) return;
        if (registry.get(key) === held) registry.delete(key);
        held.client.dispose();
      }, 0);
    },
  };
}

// --- hooks --------------------------------------------------------------------

/**
 * Subscribe to realtime events. Pass a handler per event type; each gets the
 * envelope narrowed to that type. Subscriptions clean up on unmount and when
 * url/token change; handlers may be fresh closures every render.
 *
 *   useRealtime(
 *     { "sync.progress": (e) => setProgress(e.data.done / e.data.total) },
 *     { url, token },
 *   );
 */
export function useRealtime(handlers: RealtimeHandlers, connection: RealtimeConnection): void {
  const { url, token } = connection;
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!url || !token) return;
    const { client, release } = acquire(url, token);
    const subscribe = <K extends RealtimeEventType>(type: K) =>
      client.on(type, (envelope) => handlersRef.current[type]?.(envelope));
    const unsubscribes = REALTIME_EVENT_TYPES.map(subscribe);
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      release();
    };
  }, [url, token]);
}

const serverSnapshot = (): ConnectionState => "closed";

/**
 * Connection state for a status badge: "connecting" | "open" | "retrying" |
 * "closed". Idle (no url/token yet) reads as "closed". Shares the same
 * underlying socket as useRealtime for the same url+token.
 */
export function useRealtimeStatus(connection: RealtimeConnection): ConnectionState {
  const { url, token } = connection;
  const store = useMemo(() => {
    if (!url || !token) {
      return {
        subscribe: () => () => {},
        getSnapshot: serverSnapshot,
      };
    }
    let held: { client: RealtimeClient; release: () => void } | null = null;
    return {
      subscribe(onChange: () => void) {
        held = acquire(url, token);
        const unsubscribe = held.client.onStateChange(onChange);
        return () => {
          unsubscribe();
          held?.release();
          held = null;
        };
      },
      getSnapshot(): ConnectionState {
        return held?.client.state ?? "closed";
      },
    };
  }, [url, token]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
}
