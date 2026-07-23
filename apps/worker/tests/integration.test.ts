import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { Redis } from "ioredis";
import { WebSocket } from "ws";
import { decodeEnvelope, type RealtimeEnvelope } from "@wezesha/realtime";
import { createSyncWorker } from "../src/worker";
import { createSyncQueue, enqueueSyncOnce, type SyncQueue } from "@wezesha/queue";

/**
 * End-to-end proof over real infrastructure: enqueue the demo sync job →
 * BullMQ worker publishes to Redis pub/sub → a REAL ws-gateway process
 * (spawned from apps/ws-gateway/src/index.ts) fans out → a ws client bound to
 * the tenant receives progress in order, and a client bound to another tenant
 * receives nothing. Skips without REDIS_URL.
 */

type GatewayProcess = ChildProcessByStdio<null, Readable, Readable>;

const redisUrl = process.env.REDIS_URL;
const SECRET = "integration-secret";
const TENANT_A = "tenant-int-a";
const TENANT_B = "tenant-int-b";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const gatewayEntry = path.join(repoRoot, "apps", "ws-gateway", "src", "index.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(20);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function startGatewayProcess(port: number): Promise<GatewayProcess> {
  const child = spawn(process.execPath, [tsxCli, gatewayEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      REDIS_URL: redisUrl,
      WS_DEV_TOKEN: SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gateway did not report listening\n${stderr}`)),
      20_000
    );
    child.stdout.on("data", (c: Buffer) => {
      if (c.toString().includes("listening")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited early (${code})\n${stderr}`));
    });
  });
}

function openClient(port: number, tenantId: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${SECRET}:${tenantId}`);
  const messages: string[] = [];
  ws.on("message", (data) => messages.push(data.toString()));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}

describe.skipIf(!redisUrl)("realtime pipeline (real Redis + real gateway process)", () => {
  let gatewayProc: GatewayProcess;
  let gatewayPort: number;
  let queueConnection: Redis;
  let workerConnection: Redis;
  let publisher: Redis;
  let queue: SyncQueue;
  let worker: Worker;

  beforeAll(async () => {
    gatewayPort = await freePort();
    gatewayProc = await startGatewayProcess(gatewayPort);

    queueConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    workerConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    publisher = new Redis(redisUrl!);
    queue = createSyncQueue(queueConnection);
    await queue.obliterate({ force: true });
    worker = createSyncWorker({ connection: workerConnection, publisher, phaseDelayMs: 100 });
  });

  afterAll(async () => {
    await worker?.close();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await Promise.all([queueConnection?.quit(), workerConnection?.quit(), publisher?.quit()]);
    gatewayProc?.kill();
  });

  it("streams the demo sync to the right tenant and only that tenant", async () => {
    const a = await openClient(gatewayPort, TENANT_A);
    const b = await openClient(gatewayPort, TENANT_B);

    try {
      // source "demo" exercises the demo processor — "shopify" would dispatch
      // to the real sync, which needs a live connection row.
      const result = await enqueueSyncOnce(queue, { tenantId: TENANT_A, source: "demo" });
      expect(result.enqueued).toBe(true);

      // 3 progress events + 1 done
      await waitFor(() => a.messages.length >= 4);

      const envelopes = a.messages.map((m) => decodeEnvelope(m));
      expect(envelopes.every((e) => e !== null)).toBe(true);
      const received = envelopes as RealtimeEnvelope[];

      expect(received.map((e) => e.type)).toEqual([
        "sync.progress",
        "sync.progress",
        "sync.progress",
        "sync.done",
      ]);
      expect(received.every((e) => e.data.tenantId === TENANT_A)).toBe(true);

      const progress = received.filter((e) => e.type === "sync.progress");
      expect(progress.map((e) => e.data.done)).toEqual([1, 2, 3]);
      expect(progress.map((e) => e.data.phase)).toEqual(["fetch", "transform", "load"]);
      expect(progress.every((e) => e.data.total === 3 && e.data.source === "demo")).toBe(true);

      const done = received[3]!;
      expect(done.type === "sync.done" && done.data.ok).toBe(true);

      // Grace window: any cross-tenant delivery would have surfaced by now.
      await sleep(400);
      expect(b.messages).toEqual([]);
      expect(a.messages.length).toBe(4);
    } finally {
      a.ws.terminate();
      b.ws.terminate();
    }
  });
});
