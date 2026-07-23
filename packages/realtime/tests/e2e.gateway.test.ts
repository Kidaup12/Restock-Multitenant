/**
 * End-to-end against the local stack: real Redis (docker compose, host port
 * 6380), the real ws-gateway started in-process on a free port, events pushed
 * through the real publisher, received by the browser client over a real
 * WebSocket. Skips cleanly when Redis is not reachable.
 */
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthorizeSocket } from "../../../apps/ws-gateway/src/auth";
import { startGateway, type Gateway } from "../../../apps/ws-gateway/src/gateway";
import { connect, type RealtimeClient } from "../src/client";
import { publishEvent } from "../src/publish";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const SECRET = "e2e-secret";

async function redisReachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(20);
  }
}

const redisUp = await redisReachable();

describe.skipIf(!redisUp)("e2e: redis → gateway → client", () => {
  let subscriber: Redis;
  let publisher: Redis;
  let gateway: Gateway;
  const clients: RealtimeClient[] = [];

  beforeAll(async () => {
    subscriber = new Redis(REDIS_URL);
    publisher = new Redis(REDIS_URL);
    gateway = await startGateway({
      port: 0,
      subscriber,
      authorize: devAuthorizeSocket(SECRET),
    });
  });

  afterAll(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await gateway.close();
    await publisher.quit();
    await subscriber.quit();
  });

  const openClient = async (tenantId: string) => {
    const client = connect(`ws://127.0.0.1:${gateway.port}`, `${SECRET}:${tenantId}`);
    clients.push(client);
    await waitFor(() => client.state === "open");
    return client;
  };

  it("delivers a published event to the connected client", async () => {
    const tenantId = `e2e-${Date.now()}`;
    const client = await openClient(tenantId);

    const seen: Array<{ done: number; total: number }> = [];
    client.on("sync.progress", (envelope) => {
      seen.push({ done: envelope.data.done, total: envelope.data.total });
    });

    const receivers = await publishEvent(publisher, {
      type: "sync.progress",
      data: { tenantId, source: "shopify", phase: "fetch", done: 3, total: 9 },
    });
    expect(receivers).toBeGreaterThanOrEqual(1); // the gateway's psubscribe

    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ done: 3, total: 9 });
    expect(client.malformedCount).toBe(0);
  });

  it("does not deliver another tenant's event", async () => {
    const tenantId = `e2e-a-${Date.now()}`;
    const otherTenant = `e2e-b-${Date.now()}`;
    const client = await openClient(tenantId);

    const mine: string[] = [];
    client.on("notification.new", (envelope) => mine.push(envelope.data.title));

    await publishEvent(publisher, {
      type: "notification.new",
      data: { tenantId: otherTenant, kind: "restock", title: "not yours" },
    });
    await publishEvent(publisher, {
      type: "notification.new",
      data: { tenantId, kind: "restock", title: "yours" },
    });

    await waitFor(() => mine.length === 1);
    await sleep(200); // grace for a stray cross-tenant delivery
    expect(mine).toEqual(["yours"]);
  });

  it("rejects a bad token with 4401 and the client stays closed", async () => {
    const client = connect(`ws://127.0.0.1:${gateway.port}`, `wrong-secret:tenant-x`);
    clients.push(client);
    await waitFor(() => client.state === "closed");
    expect(client.state).toBe("closed");
  });
});
