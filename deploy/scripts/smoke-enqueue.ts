/**
 * First-deploy smoke test: enqueue one demo sync job and (optionally) verify
 * the full realtime round-trip — queue → worker → Redis pub/sub → ws-gateway
 * → socket.
 *
 * Enqueue only:
 *   REDIS_URL=redis://... npx tsx deploy/scripts/smoke-enqueue.ts
 *
 * Full round-trip (opens the socket first, then enqueues, then waits for
 * sync.done on the smoke tenant; 30s timeout):
 *   REDIS_URL=redis://... \
 *   WS_URL=wss://<gateway-domain> \
 *   WS_TOKEN=<WS_DEV_TOKEN>:smoke-tenant \
 *   npx tsx deploy/scripts/smoke-enqueue.ts
 *
 * SMOKE_TENANT overrides the tenant id (default "smoke-tenant"); the tenant
 * part of WS_TOKEN must match it or the events go to a channel the socket
 * isn't bound to.
 */
import { Redis } from "ioredis";
import WebSocket from "ws";
import { createSyncQueue, enqueueSyncOnce } from "../../packages/queue/src";

const redisUrl = process.env.REDIS_URL;
const tenantId = process.env.SMOKE_TENANT ?? "smoke-tenant";
const wsUrl = process.env.WS_URL;
const wsToken = process.env.WS_TOKEN;

async function main(): Promise<void> {
  if (!redisUrl) throw new Error("REDIS_URL is required");

  const received: string[] = [];
  let socket: WebSocket | undefined;

  if (wsUrl) {
    if (!wsToken) {
      throw new Error("WS_TOKEN is required when WS_URL is set (format <WS_DEV_TOKEN>:<tenantId>)");
    }
    socket = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(wsToken)}`);
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("close", (code) => reject(new Error(`socket closed before open (code ${code})`)));
      socket!.once("error", reject);
    });
    socket.on("message", (raw) => {
      const text = raw.toString();
      console.log(`ws  <- ${text}`);
      received.push(text);
    });
    console.log("ws  connected");
  }

  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = createSyncQueue(connection);
  const result = await enqueueSyncOnce(queue, { tenantId, source: "smoke" });
  console.log("enqueue:", result);

  if (socket) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !received.some((m) => m.includes('"sync.done"'))) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const ok = received.some((m) => m.includes('"sync.done"'));
    console.log(ok ? "smoke: sync.done received — pipeline OK" : "smoke: TIMEOUT waiting for sync.done");
    socket.close();
    if (!ok) process.exitCode = 1;
  }

  await queue.close();
  await connection.quit();
}

main().catch((err) => {
  console.error("smoke: fatal", err);
  process.exit(1);
});
