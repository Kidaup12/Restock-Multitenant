import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { TENANT_CHANNEL_PATTERN, decodeEnvelope, tenantIdFromChannel } from "@wezesha/realtime";
import type { AuthorizeSocket } from "./auth";

/**
 * The slice of a Redis subscriber connection the gateway needs. ioredis
 * satisfies it directly; tests inject an in-memory fake. The caller owns the
 * connection's lifecycle — `close()` tears down only the WebSocket side.
 */
export interface PatternSubscriber {
  psubscribe(pattern: string): Promise<unknown>;
  on(
    event: "pmessage",
    listener: (pattern: string, channel: string, message: string) => void
  ): unknown;
}

export interface GatewayOptions {
  port: number;
  authorize: AuthorizeSocket;
  subscriber: PatternSubscriber;
  /** Ping cadence; a socket that misses one full interval is terminated. */
  heartbeatIntervalMs?: number;
  /** An authorizer that hasn't answered by this deadline counts as a rejection. */
  authorizeTimeoutMs?: number;
}

export interface Gateway {
  /** Actual bound port (options port 0 picks a free one). */
  port: number;
  close(): Promise<void>;
}

/* Better Auth's session cookie, plus its https-only prefixed variant. */
const SESSION_COOKIES = ["better-auth.session_token", "__Secure-better-auth.session_token"];

function cookieValue(header: string | undefined, names: string[]): string {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (names.includes(part.slice(0, eq).trim())) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return "";
}

function tokenFrom(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "ws://gateway");
  const query = url.searchParams.get("token");
  if (query) return query;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  // Browser clients can't attach headers to a WebSocket, but same-site
  // connections carry cookies — accept the session cookie directly.
  return cookieValue(req.headers.cookie, SESSION_COOKIES);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * One process, one psubscribe on `tenant:*`, N sockets each bound to exactly
 * one tenant at auth time. Fan-out routes a message ONLY to sockets bound to
 * that channel's tenant, and drops anything malformed or whose payload tenant
 * disagrees with its channel — cross-tenant delivery is the failure mode this
 * service exists to prevent.
 */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const {
    authorize,
    subscriber,
    heartbeatIntervalMs = 30_000,
    authorizeTimeoutMs = 5_000,
  } = options;

  const byTenant = new Map<string, Set<WebSocket>>();
  const sockets = new Map<WebSocket, { tenantId: string; isAlive: boolean }>();

  const wss = new WebSocketServer({ port: options.port });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  subscriber.on("pmessage", (_pattern, channel, message) => {
    const channelTenant = tenantIdFromChannel(channel);
    if (!channelTenant) return;
    const envelope = decodeEnvelope(message);
    if (!envelope || envelope.data.tenantId !== channelTenant) return;
    const bound = byTenant.get(channelTenant);
    if (!bound) return;
    for (const ws of bound) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  });
  await subscriber.psubscribe(TENANT_CHANNEL_PATTERN);

  wss.on("connection", (ws, req) => {
    void (async () => {
      // withTimeout also absorbs authorizer failures → treated as unauthorized.
      const principal = await withTimeout(authorize(tokenFrom(req)), authorizeTimeoutMs);
      if (!principal) {
        ws.close(4401, "unauthorized");
        return;
      }

      const { tenantId } = principal;
      let bound = byTenant.get(tenantId);
      if (!bound) byTenant.set(tenantId, (bound = new Set()));
      bound.add(ws);
      sockets.set(ws, { tenantId, isAlive: true });

      ws.on("pong", () => {
        const state = sockets.get(ws);
        if (state) state.isAlive = true;
      });
      ws.on("close", () => {
        sockets.delete(ws);
        const set = byTenant.get(tenantId);
        set?.delete(ws);
        if (set?.size === 0) byTenant.delete(tenantId);
      });
    })();
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of sockets) {
      if (!state.isAlive) {
        ws.terminate(); // close event cleans up the maps
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }, heartbeatIntervalMs);

  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    port,
    close: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, "server shutting down");
      return new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
