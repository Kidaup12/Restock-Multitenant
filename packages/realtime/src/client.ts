/**
 * Browser-side realtime client. Connects to the ws-gateway, decodes envelopes,
 * and fans them out to per-type subscribers with full narrowing from the
 * RealtimeEvent union. Reconnects forever with exponential backoff + jitter
 * (capped at maxDelayMs); a browser `online` event short-circuits the wait.
 *
 * Dependency-free on purpose: this module (plus ./events) is the whole browser
 * surface. Import it via `@wezesha/realtime/client` — the package root also
 * exports the ioredis publisher and must stay server-side.
 *
 * The token travels in the query string (browsers cannot set headers on a
 * WebSocket). It lives only in this closure; the client never logs, so the
 * token cannot leak through console output.
 */

import {
  decodeEnvelope,
  type RealtimeEnvelope,
  type RealtimeEnvelopeOf,
  type RealtimeEventType,
} from "./events";

// Browser-safe re-exports: everything a client-side consumer needs without
// touching the package root.
export { REALTIME_EVENT_TYPES, decodeEnvelope } from "./events";
export type {
  RealtimeEnvelope,
  RealtimeEnvelopeOf,
  RealtimeEvent,
  RealtimeEventMap,
  RealtimeEventType,
} from "./events";

export type ConnectionState = "connecting" | "open" | "retrying" | "closed";

/** Close code the gateway sends for a rejected token. Terminal: retrying the
 *  same token would only repeat the rejection, so the client stops. */
export const CLOSE_UNAUTHORIZED = 4401;

// --- injectable seams (defaults are the browser globals) ---------------------

export interface SocketMessageEvent {
  data: unknown;
}

export interface SocketCloseEvent {
  code?: number;
}

/** The slice of the WebSocket API the client uses. Browser WebSocket and
 *  node's global WebSocket both satisfy it; tests inject a fake. */
export interface RealtimeSocket {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: SocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: SocketCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  close(code?: number, reason?: string): void;
}

export type RealtimeSocketFactory = (url: string) => RealtimeSocket;

function defaultSocketFactory(url: string): RealtimeSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!Ctor) {
    throw new Error("realtime: no global WebSocket; pass options.socketFactory");
  }
  return new Ctor(url) as RealtimeSocket;
}

/** Where "online" events come from — `window` in a browser, a stub in tests. */
export interface OnlineSignal {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
}

function defaultOnlineSignal(): OnlineSignal | undefined {
  // window in a browser; absent (or inert, which is harmless) elsewhere.
  const g = globalThis as Partial<OnlineSignal>;
  return typeof g.addEventListener === "function" && typeof g.removeEventListener === "function"
    ? (g as OnlineSignal)
    : undefined;
}

export interface RealtimeClientOptions {
  /** Socket implementation; defaults to the global WebSocket. */
  socketFactory?: RealtimeSocketFactory;
  /** Source of "online" events; defaults to the window, `null` disables. */
  onlineSignal?: OnlineSignal | null;
  /** First reconnect delay. Doubles per attempt. Default 500ms. */
  baseDelayMs?: number;
  /** Reconnect delay cap. Default 30s. */
  maxDelayMs?: number;
  /** Jitter source, injectable for deterministic tests. Default Math.random. */
  random?: () => number;
}

// --- the client ---------------------------------------------------------------

export interface RealtimeClient {
  readonly state: ConnectionState;
  /** Wire messages dropped because they failed envelope validation. */
  readonly malformedCount: number;
  /** Subscribe to one event type. Returns the unsubscribe function. */
  on<K extends RealtimeEventType>(
    type: K,
    handler: (envelope: RealtimeEnvelopeOf<K>) => void
  ): () => void;
  /** Observe connection-state transitions (for UI badges). Returns unsubscribe. */
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  /** Close the socket, cancel retries, drop all subscriptions. Idempotent. */
  dispose(): void;
}

/**
 * Open a reconnecting connection to the gateway. `url` is the gateway origin
 * (ws:// or wss://); the token is appended as the `token` query parameter.
 *
 * Lifecycle: connecting → open, then on loss retrying → connecting → … until
 * dispose() or the gateway rejects the token (close 4401), both of which end
 * at "closed" permanently. A fresh token means a fresh connect().
 */
export function connect(
  url: string,
  token: string,
  options: RealtimeClientOptions = {}
): RealtimeClient {
  const {
    socketFactory = defaultSocketFactory,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    random = Math.random,
  } = options;
  const onlineSignal =
    options.onlineSignal === undefined ? defaultOnlineSignal() : options.onlineSignal ?? undefined;

  const target = `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

  const handlers = new Map<RealtimeEventType, Set<(envelope: RealtimeEnvelope) => void>>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  let state: ConnectionState = "connecting";
  let malformed = 0;
  let attempt = 0;
  let socket: RealtimeSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0; // bumped whenever the current socket is abandoned
  let done = false; // disposed or auth-rejected; no further activity

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) listener(next);
  }

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(): void {
    if (done) return;
    setState("retrying");
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    attempt += 1;
    const delay = exp / 2 + random() * (exp / 2); // equal jitter
    retryTimer = setTimeout(() => {
      retryTimer = null;
      openSocket(false);
    }, delay);
  }

  function openSocket(initial: boolean): void {
    if (done) return;
    setState("connecting");
    const gen = ++generation;
    let ws: RealtimeSocket;
    try {
      ws = socketFactory(target);
    } catch (err) {
      if (initial) throw err; // e.g. malformed url — fail fast, don't retry-loop
      scheduleRetry();
      return;
    }
    socket = ws;
    const live = () => !done && gen === generation;

    ws.addEventListener("open", () => {
      if (!live()) return;
      attempt = 0;
      setState("open");
    });
    ws.addEventListener("message", (event) => {
      if (!live()) return;
      const envelope = typeof event.data === "string" ? decodeEnvelope(event.data) : null;
      if (!envelope) {
        malformed += 1;
        return;
      }
      const set = handlers.get(envelope.type);
      if (!set) return;
      for (const handler of [...set]) handler(envelope);
    });
    ws.addEventListener("close", (event) => {
      if (!live()) return;
      socket = null;
      if (event.code === CLOSE_UNAUTHORIZED) {
        shutdown(null);
        return;
      }
      scheduleRetry();
    });
    ws.addEventListener("error", () => {
      // a close event always follows; retry is scheduled there
    });
  }

  function shutdown(closeCurrent: RealtimeSocket | null): void {
    if (done) return;
    done = true;
    clearRetry();
    onlineSignal?.removeEventListener("online", handleOnline);
    generation += 1; // anything still buffered from the old socket is stale
    socket = null;
    if (closeCurrent) {
      try {
        closeCurrent.close(1000, "dispose");
      } catch {
        // already closing/closed
      }
    }
    setState("closed");
    handlers.clear();
    stateListeners.clear();
  }

  const handleOnline = (): void => {
    // Network came back: skip the rest of the wait and start the ladder over.
    if (done || state !== "retrying") return;
    clearRetry();
    attempt = 0;
    openSocket(false);
  };

  onlineSignal?.addEventListener("online", handleOnline);
  try {
    openSocket(true);
  } catch (err) {
    onlineSignal?.removeEventListener("online", handleOnline);
    throw err;
  }

  return {
    get state() {
      return state;
    },
    get malformedCount() {
      return malformed;
    },
    on(type, handler) {
      if (done) return () => {};
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      const entry = handler as (envelope: RealtimeEnvelope) => void;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },
    onStateChange(listener) {
      if (done) return () => {};
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    dispose() {
      shutdown(socket);
    },
  };
}
