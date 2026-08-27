import crypto from "node:crypto";
import http from "node:http";
import type { Redis } from "ioredis";
import { enqueueSyncOnce, type SyncJobData, type SyncQueue } from "@wezesha/queue";
import { publishEvent, type RealtimeEvent } from "@wezesha/realtime";

/**
 * Authenticated HTTP intake for work the web app used to push into Redis
 * directly.
 *
 * The web app and the worker share a queue. While both ran on the same
 * platform that queue stayed on a private network; hosting the web app
 * elsewhere would mean exposing Redis to the internet, where its AUTH password
 * travels in clear text. This endpoint is the alternative: the web app makes an
 * ordinary HTTPS request, the platform terminates TLS, and Redis stays private.
 *
 * Fail-closed: with no INTERNAL_API_SECRET the server does not start at all,
 * rather than starting unauthenticated.
 */

const MAX_BODY_BYTES = 64 * 1024;

export interface IntakeOptions {
  port: number;
  secret: string;
  queue: SyncQueue;
  publisher: Redis;
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(secret, "utf8");
  // Length check first: timingSafeEqual throws on a mismatch, and the length of
  // a shared secret is not the part worth hiding.
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function isSyncJobData(value: unknown): value is SyncJobData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.tenantId === "string" && v.tenantId.length > 0 && typeof v.source === "string";
}

export interface IntakeHandle {
  /** Bound port. Useful when the caller passed 0 and let the OS choose. */
  port: number;
  close: () => Promise<void>;
}

/** Start the intake server; resolves once it is listening. */
export function startIntake(options: IntakeOptions): Promise<IntakeHandle> {
  const { port, secret, queue, publisher } = options;

  const server = http.createServer((req, res) => {
    void (async () => {
      // Liveness is unauthenticated on purpose: it carries no data, and a
      // platform health probe has no credential to present.
      if (req.method === "GET" && req.url === "/internal/live") {
        send(res, 200, { ok: true });
        return;
      }
      if (!authorized(req.headers.authorization, secret)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method !== "POST") {
        send(res, 405, { error: "method not allowed" });
        return;
      }

      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : "bad request" });
        return;
      }

      try {
        if (req.url === "/internal/enqueue") {
          if (!isSyncJobData(body)) {
            send(res, 400, { error: "tenantId and source are required" });
            return;
          }
          send(res, 200, await enqueueSyncOnce(queue, body));
          return;
        }
        if (req.url === "/internal/publish") {
          const event = (body as { event?: RealtimeEvent }).event;
          if (!event) {
            send(res, 400, { error: "event is required" });
            return;
          }
          send(res, 200, { receivers: await publishEvent(publisher, event) });
          return;
        }
        send(res, 404, { error: "not found" });
      } catch (err) {
        console.error("worker: intake failed", err);
        send(res, 500, { error: "intake failed" });
      }
    })();
  });

  return new Promise<IntakeHandle>((resolve) => {
    server.listen(port, () => {
      const bound = (server.address() as { port: number }).port;
      console.log(`worker: intake listening on :${bound}`);
      resolve({
        port: bound,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
