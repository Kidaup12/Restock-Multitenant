import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ErrorEvent, NodeOptions } from "@sentry/node";
import { WebSocket } from "ws";
import { _resetForTests, flushObservability, initObservability } from "@wezesha/observability";
import { devAuthorizeSocket } from "../src/auth";
import { startGateway, type Gateway, type PatternSubscriber } from "../src/gateway";

/**
 * What the gateway reports when something below the process level breaks.
 * Everything here runs against a recording transport (no network, no real
 * DSN), so an assertion about "what Sentry would have seen" is an assertion
 * about a real captured event.
 *
 * The line these tests draw: an authorizer that ANSWERS "no" is normal traffic
 * (bad token, expired session, a workspace the user doesn't hold) and must
 * stay silent; an authorizer that FAILS to answer — throws, or hangs past the
 * deadline — is infrastructure and must be reported with the workspace the
 * connection asked for.
 */

const SECRET = "test-secret";
const TEST_DSN = "https://examplePublicKey@o0.ingest.example.test/0";

// Structural slice of Sentry's envelope tuple ([headers, [[itemHeaders, payload], ...]]).
type EnvelopeItem = [{ type?: string }, unknown];
type RecordedEnvelope = [unknown, EnvelopeItem[]];

class FakeSubscriber implements PatternSubscriber {
  private listeners: Array<(p: string, c: string, m: string) => void> = [];
  async psubscribe(): Promise<void> {}
  on(_event: "pmessage", listener: (p: string, c: string, m: string) => void): this {
    this.listeners.push(listener);
    return this;
  }
  emit(channel: string, message: string): void {
    for (const l of this.listeners) l("tenant:*", channel, message);
  }
}

function makeRecorder() {
  const envelopes: RecordedEnvelope[] = [];
  const transport = (() => ({
    send: (envelope: unknown) => {
      envelopes.push(envelope as RecordedEnvelope);
      return Promise.resolve({});
    },
    flush: () => Promise.resolve(true),
  })) as NonNullable<NodeOptions["transport"]>;
  const events = (): ErrorEvent[] => {
    const out: ErrorEvent[] = [];
    for (const envelope of envelopes) {
      for (const item of envelope[1]) {
        if (item[0]?.type === "event") out.push(item[1] as ErrorEvent);
      }
    }
    return out;
  };
  return { transport, events };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Captured events are queued asynchronously; drain before asserting. */
async function settle(): Promise<void> {
  await sleep(150);
  await flushObservability(1000);
}

// The SDK arrives through a dynamic import inside initObservability; pull it in
// once so no individual test is timed against the loader.
beforeAll(async () => {
  await import("@sentry/node");
}, 180_000);

describe("ws-gateway error reporting", () => {
  let gateway: Gateway | undefined;
  const sockets: WebSocket[] = [];
  let recorder = makeRecorder();

  beforeEach(async () => {
    _resetForTests();
    recorder = makeRecorder();
    await initObservability("ws-gateway", {
      dsn: TEST_DSN,
      environment: "test",
      transport: recorder.transport,
    });
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await gateway?.close();
    gateway = undefined;
    _resetForTests();
  });

  const connect = (port: number, token: string, workspace?: string): WebSocket => {
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (workspace) params.set("workspace", workspace);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${params.toString()}`);
    ws.on("error", () => {}); // client-side noise is not what's under test
    sockets.push(ws);
    return ws;
  };

  it("reports an authorizer that throws, tagged with the requested workspace", async () => {
    gateway = await startGateway({
      port: 0,
      subscriber: new FakeSubscriber(),
      authorize: async () => {
        throw new Error("session store unreachable");
      },
    });
    connect(gateway.port, "any-token", "tenant-x");
    await settle();

    const events = recorder.events();
    expect(events.length).toBe(1);
    expect(events[0]?.tags?.tenantId).toBe("tenant-x");
    expect(events[0]?.tags?.origin).toBe("authorize");
    expect(events[0]?.exception?.values?.[0]?.value).toContain("session store unreachable");
  });

  it("reports an authorizer that never answers", async () => {
    gateway = await startGateway({
      port: 0,
      subscriber: new FakeSubscriber(),
      authorize: () => new Promise(() => {}),
      authorizeTimeoutMs: 50,
    });
    connect(gateway.port, "any-token", "tenant-x");
    await settle();

    const events = recorder.events();
    expect(events.length).toBe(1);
    expect(events[0]?.tags?.origin).toBe("authorize-timeout");
    expect(events[0]?.tags?.tenantId).toBe("tenant-x");
  });

  it("stays silent when the authorizer simply says no", async () => {
    gateway = await startGateway({
      port: 0,
      subscriber: new FakeSubscriber(),
      authorize: devAuthorizeSocket(SECRET),
    });
    // Three routine rejects: wrong secret, no credential, and a token shaped
    // wrong. None of these is an incident.
    connect(gateway.port, "wrong:tenant-a", "tenant-a");
    connect(gateway.port, "");
    connect(gateway.port, "no-separator");
    await settle();

    expect(recorder.events()).toEqual([]);
  });

  it("survives and reports a socket-level protocol error", async () => {
    gateway = await startGateway({
      port: 0,
      subscriber: new FakeSubscriber(),
      authorize: devAuthorizeSocket(SECRET),
    });
    const ws = connect(gateway.port, `${SECRET}:tenant-a`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    // A frame with the reserved RSV1 bit set: the server's receiver rejects it
    // and errors the socket. Without a listener that is an unhandled 'error'
    // event, which takes the whole gateway — and every other tenant's socket
    // — down with it.
    const raw = (ws as unknown as { _socket: { write(b: Buffer): void } })._socket;
    raw.write(Buffer.from([0xc1, 0x00]));
    await settle();

    const events = recorder.events();
    expect(events.length).toBe(1);
    expect(events[0]?.tags?.origin).toBe("socket");
    expect(events[0]?.tags?.tenantId).toBe("tenant-a");
  });

  it("reports a fan-out failure against the channel's tenant", async () => {
    const sub = new FakeSubscriber();
    gateway = await startGateway({
      port: 0,
      subscriber: sub,
      authorize: devAuthorizeSocket(SECRET),
    });
    const ws = connect(gateway.port, `${SECRET}:tenant-a`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await sleep(50);
    // Stand in for any send-path failure (a socket wedged between the
    // readyState check and the write): the delivery loop must not throw back
    // into the Redis listener, where it would kill the process.
    const original = WebSocket.prototype.send;
    (WebSocket.prototype as { send: unknown }).send = function () {
      throw new Error("socket write failed");
    };
    try {
      sub.emit(
        "tenant:tenant-a",
        JSON.stringify({
          type: "sync.progress",
          ts: Date.now(),
          data: { tenantId: "tenant-a", source: "shopify", phase: "fetch", done: 1, total: 3 },
        })
      );
      await settle();
    } finally {
      (WebSocket.prototype as { send: unknown }).send = original;
    }

    const events = recorder.events();
    expect(events.length).toBe(1);
    expect(events[0]?.tags?.origin).toBe("fanout");
    expect(events[0]?.tags?.tenantId).toBe("tenant-a");
  });
});
