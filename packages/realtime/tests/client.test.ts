import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  CLOSE_UNAUTHORIZED,
  connect,
  type ConnectionState,
  type OnlineSignal,
  type RealtimeClient,
  type RealtimeSocket,
  type SocketCloseEvent,
  type SocketMessageEvent,
} from "../src/client";
import { encodeEnvelope, type RealtimeEvent } from "../src/events";

class FakeSocket implements RealtimeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  closedBy: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (event: unknown) => void);
  }

  close(code?: number, reason?: string): void {
    this.closedBy = { code, reason };
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.emit("open", {});
  }
  message(data: unknown): void {
    this.emit("message", { data } satisfies SocketMessageEvent);
  }
  serverClose(code: number): void {
    this.emit("close", { code } satisfies SocketCloseEvent);
  }
}

class FakeOnlineSignal implements OnlineSignal {
  private listeners = new Set<() => void>();
  addEventListener(_type: "online", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "online", listener: () => void): void {
    this.listeners.delete(listener);
  }
  fireOnline(): void {
    for (const listener of [...this.listeners]) listener();
  }
  get count(): number {
    return this.listeners.size;
  }
}

const socketFactory = (url: string) => new FakeSocket(url);
const latest = () => FakeSocket.instances.at(-1)!;

const progress: RealtimeEvent = {
  type: "sync.progress",
  data: { tenantId: "t1", source: "shopify", phase: "fetch", done: 1, total: 3 },
};
const notification: RealtimeEvent = {
  type: "notification.new",
  data: { tenantId: "t1", kind: "restock", title: "Buy list ready" },
};

function trackStates(client: RealtimeClient): ConnectionState[] {
  const states: ConnectionState[] = [];
  client.onStateChange((s) => states.push(s));
  return states;
}

describe("realtime client", () => {
  const clients: RealtimeClient[] = [];
  const make = (opts: Parameters<typeof connect>[2] = {}) => {
    const client = connect("ws://gw.test", "secret-token", {
      socketFactory,
      onlineSignal: null,
      random: () => 1, // deterministic: delay = min(max, base * 2^attempt)
      ...opts,
    });
    clients.push(client);
    return client;
  };

  beforeEach(() => {
    FakeSocket.instances = [];
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("connection basics", () => {
    it("appends the token as a query parameter, url-encoded", () => {
      make();
      expect(latest().url).toBe("ws://gw.test?token=secret-token");
      connect("ws://gw.test/ws?v=2", "a:b/c", { socketFactory, onlineSignal: null }).dispose();
      expect(latest().url).toBe("ws://gw.test/ws?v=2&token=a%3Ab%2Fc");
    });

    it("moves connecting → open and resets nothing on data", () => {
      const client = make();
      const states = trackStates(client);
      expect(client.state).toBe("connecting");
      latest().open();
      expect(client.state).toBe("open");
      expect(states).toEqual(["open"]);
    });

    it("never logs (token stays out of console output)", () => {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m)
      );
      vi.useFakeTimers();
      const client = make();
      latest().open();
      latest().message("not json");
      latest().serverClose(1006);
      vi.advanceTimersByTime(60_000);
      client.dispose();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("subscriptions", () => {
    it("routes each event type to its handlers with narrowed payloads", () => {
      const client = make();
      const progressSeen: number[] = [];
      const noteSeen: string[] = [];
      client.on("sync.progress", (envelope) => {
        expectTypeOf(envelope.type).toEqualTypeOf<"sync.progress">();
        expectTypeOf(envelope.data).toEqualTypeOf<{
          tenantId: string;
          source: string;
          phase: string;
          done: number;
          total: number;
        }>();
        progressSeen.push(envelope.data.done);
      });
      client.on("notification.new", (envelope) => {
        expectTypeOf(envelope.data.title).toEqualTypeOf<string>();
        noteSeen.push(envelope.data.title);
      });
      const neverCalled = vi.fn();
      client.on("forecast.done", neverCalled);

      latest().open();
      latest().message(encodeEnvelope(progress));
      latest().message(encodeEnvelope(notification));
      latest().message(encodeEnvelope(progress));

      expect(progressSeen).toEqual([1, 1]);
      expect(noteSeen).toEqual(["Buy list ready"]);
      expect(neverCalled).not.toHaveBeenCalled();
    });

    it("unsubscribe stops delivery without touching other handlers", () => {
      const client = make();
      const first = vi.fn();
      const second = vi.fn();
      const unsubscribe = client.on("sync.progress", first);
      client.on("sync.progress", second);
      latest().open();
      latest().message(encodeEnvelope(progress));
      unsubscribe();
      latest().message(encodeEnvelope(progress));
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
    });

    it("subscriptions survive a reconnect", () => {
      vi.useFakeTimers();
      const client = make();
      const handler = vi.fn();
      client.on("sync.progress", handler);
      latest().open();
      latest().serverClose(1006);
      vi.advanceTimersByTime(500);
      expect(FakeSocket.instances).toHaveLength(2);
      latest().open();
      latest().message(encodeEnvelope(progress));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("malformed messages", () => {
    it("drops them silently but counts them", () => {
      const client = make();
      const handler = vi.fn();
      client.on("sync.progress", handler);
      latest().open();
      latest().message("not json");
      latest().message(JSON.stringify({ type: "nope", ts: 1, data: {} }));
      latest().message(JSON.stringify({ type: "sync.done", data: { tenantId: "t" } }));
      latest().message(new ArrayBuffer(4)); // non-text frame
      latest().message(encodeEnvelope(progress)); // still healthy afterwards
      expect(client.malformedCount).toBe(4);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(client.state).toBe("open");
    });
  });

  describe("reconnect and backoff", () => {
    it("retries with exponential delays capped at maxDelayMs", () => {
      vi.useFakeTimers();
      const client = make(); // random()=1 → delay = min(30s, 500 * 2^attempt)
      latest().open();

      const expected = [500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
      for (const delay of expected) {
        const before = FakeSocket.instances.length;
        latest().serverClose(1006);
        expect(client.state).toBe("retrying");
        vi.advanceTimersByTime(delay - 1);
        expect(FakeSocket.instances).toHaveLength(before);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(before + 1);
        expect(client.state).toBe("connecting");
      }
    });

    it("jitter draws the delay from [exp/2, exp]", () => {
      vi.useFakeTimers();
      make({ random: () => 0 }); // lower bound: exp/2
      latest().serverClose(1006);
      vi.advanceTimersByTime(249);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1); // 250ms = 500/2
      expect(FakeSocket.instances).toHaveLength(2);
    });

    it("a successful open resets the backoff ladder", () => {
      vi.useFakeTimers();
      make();
      latest().serverClose(1006);
      vi.advanceTimersByTime(500);
      latest().serverClose(1006);
      vi.advanceTimersByTime(1000);
      latest().open(); // attempt counter back to 0
      latest().serverClose(1006);
      vi.advanceTimersByTime(500); // back to the base delay
      expect(FakeSocket.instances).toHaveLength(4);
    });

    it("emits connecting/open/retrying transitions for the badge", () => {
      vi.useFakeTimers();
      const client = make();
      const states = trackStates(client);
      latest().open();
      latest().serverClose(1006);
      vi.advanceTimersByTime(500);
      latest().open();
      expect(states).toEqual(["open", "retrying", "connecting", "open"]);
    });

    it("a socketFactory failure during a retry schedules the next retry", () => {
      vi.useFakeTimers();
      let fail = false;
      const client = make({
        socketFactory: (url) => {
          if (fail) throw new Error("offline");
          return new FakeSocket(url);
        },
      });
      fail = true;
      latest().serverClose(1006);
      vi.advanceTimersByTime(500); // attempt throws → schedules again
      expect(client.state).toBe("retrying");
      fail = false;
      vi.advanceTimersByTime(1000);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(client.state).toBe("connecting");
    });
  });

  describe("online awareness", () => {
    it("an online event cuts the wait short and resets backoff", () => {
      vi.useFakeTimers();
      const signal = new FakeOnlineSignal();
      const client = make({ onlineSignal: signal });
      latest().open();
      // Pile up failures so the pending delay is long.
      for (const delay of [500, 1000, 2000, 4000]) {
        latest().serverClose(1006);
        vi.advanceTimersByTime(delay);
      }
      latest().serverClose(1006);
      expect(client.state).toBe("retrying");
      const before = FakeSocket.instances.length;

      signal.fireOnline(); // immediate, no timer advance
      expect(FakeSocket.instances).toHaveLength(before + 1);
      expect(client.state).toBe("connecting");

      latest().serverClose(1006); // ladder restarted at the base delay
      vi.advanceTimersByTime(500);
      expect(FakeSocket.instances).toHaveLength(before + 2);
    });

    it("online while open or closed is a no-op", () => {
      const signal = new FakeOnlineSignal();
      const client = make({ onlineSignal: signal });
      latest().open();
      signal.fireOnline();
      expect(FakeSocket.instances).toHaveLength(1);
      client.dispose();
      signal.fireOnline();
      expect(FakeSocket.instances).toHaveLength(1);
    });
  });

  describe("auth rejection", () => {
    it("close 4401 is terminal: no retry, state closed", () => {
      vi.useFakeTimers();
      const client = make();
      const states = trackStates(client);
      latest().serverClose(CLOSE_UNAUTHORIZED);
      expect(client.state).toBe("closed");
      vi.advanceTimersByTime(120_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(states).toEqual(["closed"]);
    });
  });

  describe("dispose", () => {
    it("closes the socket, cancels retries, and detaches the online signal", () => {
      vi.useFakeTimers();
      const signal = new FakeOnlineSignal();
      const client = make({ onlineSignal: signal });
      const socket = latest();
      socket.open();
      client.dispose();

      expect(client.state).toBe("closed");
      expect(socket.closedBy?.code).toBe(1000);
      expect(signal.count).toBe(0);
      vi.advanceTimersByTime(120_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it("is idempotent and inert afterwards", () => {
      const client = make();
      const handler = vi.fn();
      client.dispose();
      client.dispose();
      expect(client.on("sync.progress", handler)).toBeTypeOf("function");
      expect(client.onStateChange(() => {})).toBeTypeOf("function");
      expect(client.state).toBe("closed");
      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores events from a socket abandoned mid-retry", () => {
      vi.useFakeTimers();
      const client = make();
      const handler = vi.fn();
      client.on("sync.progress", handler);
      const stale = latest();
      stale.serverClose(1006);
      vi.advanceTimersByTime(500); // replacement socket exists now
      stale.open();
      stale.message(encodeEnvelope(progress));
      expect(handler).not.toHaveBeenCalled();
      expect(client.malformedCount).toBe(0);
      expect(client.state).toBe("connecting");
    });
  });
});
