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
}

export interface Gateway {
  /** Actual bound port (options port 0 picks a free one). */
  port: number;
  close(): Promise<void>;
}

function tokenFrom(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "ws://gateway");
  const query = url.searchParams.get("token");
  if (query) return query;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return "";
}

/**
 * One process, one psubscribe on `tenant:*`, N sockets each bound to exactly
 * one tenant at auth time. Fan-out routes a message ONLY to sockets bound to
 * that channel's tenant, and drops anything malformed or whose payload tenant
 * disagrees with its channel — cross-tenant delivery is the failure mode this
 * service exists to prevent.
 */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const { authorize, subscriber, heartbeatIntervalMs = 30_000 } = options;

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
      let principal: Awaited<ReturnType<AuthorizeSocket>> = null;
      try {
        principal = await authorize(tokenFrom(req));
      } catch {
        // authorizer failure → treat as unauthorized
      }
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
