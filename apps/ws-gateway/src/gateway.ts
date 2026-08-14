import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { captureError } from "@wezesha/observability";
import { TENANT_CHANNEL_PATTERN, decodeEnvelope, tenantIdFromChannel } from "@wezesha/realtime";
import type { AuthorizeSocket, SocketPrincipal } from "./auth";

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

/** The workspace (tenant id) the client wants this socket bound to; null when
 *  it didn't say. The authorizer decides whether the request is honored. */
function workspaceFrom(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "ws://gateway");
  return url.searchParams.get("workspace") || null;
}

/**
 * A connection either gets in or doesn't — but *why* it didn't matters to
 * reporting. "denied" is the authorizer answering no (bad token, expired
 * session, a workspace the user doesn't hold): ordinary traffic, and the bulk
 * of it. "failed" and "timeout" are the authorizer not answering at all —
 * the session store is down or wedged — which is an incident even though the
 * client sees the same 4401.
 */
type AuthorizeOutcome =
  | { status: "ok"; principal: SocketPrincipal }
  | { status: "denied" }
  | { status: "failed"; err: unknown }
  | { status: "timeout" };

function runAuthorize(
  attempt: Promise<SocketPrincipal | null>,
  ms: number
): Promise<AuthorizeOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timeout" }), ms);
    attempt.then(
      (principal) => {
        clearTimeout(timer);
        resolve(principal ? { status: "ok", principal } : { status: "denied" });
      },
      (err) => {
        clearTimeout(timer);
        resolve({ status: "failed", err });
      }
    );
  });
}

/**
 * A tenant id asked for by an unauthenticated connection is client-controlled
 * text, so it is only worth tagging when it is shaped like one of our ids —
 * otherwise a client could pollute the tracker's tag cardinality at will.
 * Nothing else from the request (token, cookies, payloads) ever reaches a tag.
 */
function tagSafeTenantId(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
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

  // Own the HTTP server (instead of letting ws create one) so the same port
  // answers a plain-HTTP liveness probe alongside the WebSocket upgrades.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ uptime: process.uptime(), connections: sockets.size }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  subscriber.on("pmessage", (_pattern, channel, message) => {
    const channelTenant = tenantIdFromChannel(channel);
    if (!channelTenant) return;
    // This runs inside the Redis client's emit: an escaping throw would take
    // the process, and every other tenant's socket, with it. One report per
    // message, never one per socket — a wedged fan-out shouldn't flood.
    let failure: unknown;
    try {
      const envelope = decodeEnvelope(message);
      if (!envelope || envelope.data.tenantId !== channelTenant) return;
      const bound = byTenant.get(channelTenant);
      if (!bound) return;
      for (const ws of bound) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(message);
        } catch (err) {
          failure ??= err; // keep delivering to the rest of the tenant's sockets
        }
      }
    } catch (err) {
      failure ??= err;
    }
    if (failure !== undefined) {
      captureError(failure, { origin: "fanout", tenantId: channelTenant });
    }
  });
  await subscriber.psubscribe(TENANT_CHANNEL_PATTERN);

  wss.on("error", (err) => {
    captureError(err, { origin: "server" });
  });

  wss.on("connection", (ws, req) => {
    const requestedTenantId = workspaceFrom(req);
    // Attach before the first await: an unhandled 'error' event on a socket
    // throws out of the emitter and kills the process. Until the socket is
    // bound, the only tenant to attribute it to is the one it asked for.
    ws.on("error", (err) => {
      captureError(err, {
        origin: "socket",
        tenantId: sockets.get(ws)?.tenantId ?? tagSafeTenantId(requestedTenantId),
      });
    });

    void (async () => {
      const outcome = await runAuthorize(
        authorize(tokenFrom(req), requestedTenantId),
        authorizeTimeoutMs
      );
      if (outcome.status !== "ok") {
        // A "no" is routine and stays silent; an authorizer that broke or
        // hung is reported, tagged with the workspace that couldn't connect.
        if (outcome.status === "failed") {
          captureError(outcome.err, {
            origin: "authorize",
            tenantId: tagSafeTenantId(requestedTenantId),
          });
        } else if (outcome.status === "timeout") {
          captureError(new Error(`authorize did not answer within ${authorizeTimeoutMs}ms`), {
            origin: "authorize-timeout",
            tenantId: tagSafeTenantId(requestedTenantId),
          });
        }
        ws.close(4401, "unauthorized");
        return;
      }

      const { tenantId } = outcome.principal;
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
    })().catch((err) => {
      // Nothing above should throw, but an unhandled rejection here reaches
      // the process handler and exits — report it with the socket's tenant
      // and drop just this connection instead.
      captureError(err, {
        origin: "connection",
        tenantId: sockets.get(ws)?.tenantId ?? tagSafeTenantId(requestedTenantId),
      });
      ws.close(1011, "internal error");
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of sockets) {
      try {
        if (!state.isAlive) {
          ws.terminate(); // close event cleans up the maps
          continue;
        }
        state.isAlive = false;
        ws.ping();
      } catch (err) {
        // A timer callback throws straight into the process handler; one bad
        // socket must not end the sweep for the others.
        captureError(err, { origin: "heartbeat", tenantId: state.tenantId });
      }
    }
  }, heartbeatIntervalMs);

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    port,
    close: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, "server shutting down");
      return new Promise<void>((resolve, reject) => {
        // wss.close does not close a caller-provided HTTP server — chain it.
        wss.close((wsErr) => {
          server.close((httpErr) => {
            const err = wsErr ?? httpErr;
            if (err) reject(err);
            else resolve();
          });
          // Sever lingering keep-alive probe connections so close() can finish.
          server.closeAllConnections();
        });
      });
    },
  };
}
