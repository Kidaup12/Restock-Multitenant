import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { decodeEnvelope, encodeEnvelope, tenantChannel, type RealtimeEvent } from "@wezesha/realtime";
import { devAuthorizeSocket } from "../src/auth";
import { startGateway, type Gateway, type PatternSubscriber } from "../src/gateway";

const SECRET = "test-secret";

class FakeSubscriber implements PatternSubscriber {
  patterns: string[] = [];
  private listeners: Array<(p: string, c: string, m: string) => void> = [];
  async psubscribe(pattern: string): Promise<void> {
    this.patterns.push(pattern);
  }
  on(_event: "pmessage", listener: (p: string, c: string, m: string) => void): this {
    this.listeners.push(listener);
    return this;
  }
  emit(channel: string, message: string): void {
    for (const l of this.listeners) l("tenant:*", channel, message);
  }
}

interface Client {
  ws: WebSocket;
  messages: string[];
  closed: Promise<{ code: number; reason: string }>;
}

function connect(port: number, token: string, opts?: { autoPong?: boolean }): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
    autoPong: opts?.autoPong ?? true,
  });
  const messages: string[] = [];
  ws.on("message", (data) => messages.push(data.toString()));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  return { ws, messages, closed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(10);
  }
}

function progressEvent(tenantId: string, done = 1): RealtimeEvent {
  return {
    type: "sync.progress",
    data: { tenantId, source: "shopify", phase: "fetch", done, total: 3 },
  };
}

describe("ws-gateway", () => {
  let gateway: Gateway | undefined;
  const clients: Client[] = [];

  const start = async (subscriber: FakeSubscriber, heartbeatIntervalMs?: number) => {
    gateway = await startGateway({
      port: 0,
      subscriber,
      authorize: devAuthorizeSocket(SECRET),
      heartbeatIntervalMs,
    });
    return gateway;
  };

  const open = async (port: number, token: string, opts?: { autoPong?: boolean }) => {
    const client = connect(port, token, opts);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.ws.once("open", resolve);
      client.ws.once("error", reject);
    });
    return client;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    await gateway?.close();
    gateway = undefined;
  });

  it("subscribes once to the tenant pattern", async () => {
    const sub = new FakeSubscriber();
    await start(sub);
    expect(sub.patterns).toEqual(["tenant:*"]);
  });

  it("closes unauthorized connections with 4401", async () => {
    const { port } = await start(new FakeSubscriber());
    const wrongSecret = await open(port, "nope:tenant-a");
    expect(await wrongSecret.closed).toEqual({ code: 4401, reason: "unauthorized" });
    const noToken = connect(port, "");
    clients.push(noToken);
    expect((await noToken.closed).code).toBe(4401);
  });

  it("delivers a tenant's events to its bound sockets", async () => {
    const sub = new FakeSubscriber();
    const { port } = await start(sub);
    const a = await open(port, `${SECRET}:tenant-a`);

    sub.emit(tenantChannel("tenant-a"), encodeEnvelope(progressEvent("tenant-a")));
    await waitFor(() => a.messages.length === 1);

    const envelope = decodeEnvelope(a.messages[0]!);
    expect(envelope?.type).toBe("sync.progress");
    expect(envelope?.data.tenantId).toBe("tenant-a");
  });

  it("never delivers tenant B's events to a socket authorized for tenant A", async () => {
    const sub = new FakeSubscriber();
    const { port } = await start(sub);
    const a = await open(port, `${SECRET}:tenant-a`);
    const b = await open(port, `${SECRET}:tenant-b`);

    sub.emit(tenantChannel("tenant-b"), encodeEnvelope(progressEvent("tenant-b")));
    await waitFor(() => b.messages.length === 1);
    await sleep(100); // grace: give a stray delivery to A time to surface
    expect(a.messages).toEqual([]);

    sub.emit(tenantChannel("tenant-a"), encodeEnvelope(progressEvent("tenant-a")));
    await waitFor(() => a.messages.length === 1);
    await sleep(100);
    expect(b.messages.length).toBe(1); // still only its own event
    expect(decodeEnvelope(a.messages[0]!)?.data.tenantId).toBe("tenant-a");
    expect(decodeEnvelope(b.messages[0]!)?.data.tenantId).toBe("tenant-b");
  });

  it("drops a message whose payload tenant disagrees with its channel", async () => {
    const sub = new FakeSubscriber();
    const { port } = await start(sub);
    const a = await open(port, `${SECRET}:tenant-a`);
    const b = await open(port, `${SECRET}:tenant-b`);

    // A buggy publisher put tenant B's event on tenant A's channel: nobody gets it.
    sub.emit(tenantChannel("tenant-a"), encodeEnvelope(progressEvent("tenant-b")));
    await sleep(150);
    expect(a.messages).toEqual([]);
    expect(b.messages).toEqual([]);
  });

  it("drops malformed messages instead of forwarding them", async () => {
    const sub = new FakeSubscriber();
    const { port } = await start(sub);
    const a = await open(port, `${SECRET}:tenant-a`);

    sub.emit(tenantChannel("tenant-a"), "not json");
    sub.emit(tenantChannel("tenant-a"), JSON.stringify({ type: "nope", ts: 1, data: {} }));
    await sleep(150);
    expect(a.messages).toEqual([]);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("terminates sockets that stop answering heartbeat pings", async () => {
    const sub = new FakeSubscriber();
    const { port } = await start(sub, 50);
    const dead = await open(port, `${SECRET}:tenant-a`, { autoPong: false });
    const { code } = await dead.closed; // reaped within ~2 intervals
    expect(code).toBe(1006); // terminated without a close frame
  });

  it("closes clients gracefully on shutdown", async () => {
    const { port } = await start(new FakeSubscriber());
    const a = await open(port, `${SECRET}:tenant-a`);
    await gateway!.close();
    gateway = undefined;
    expect((await a.closed).code).toBe(1001);
  });
});
