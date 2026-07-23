/**
 * The client against a real `ws` server in-process: token handoff, delivery,
 * malformed counting, reconnect after a server-side drop, dispose close code.
 * The fake-socket suite covers timing; this one proves the client speaks real
 * WebSocket via the global implementation (same API surface as the browser).
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { connect, type RealtimeClient } from "../src/client";
import { encodeEnvelope, type RealtimeEvent } from "../src/events";

const progress: RealtimeEvent = {
  type: "sync.progress",
  data: { tenantId: "t1", source: "shopify", phase: "fetch", done: 2, total: 5 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(10);
  }
}

interface Fixture {
  wss: WebSocketServer;
  port: number;
  sockets: ServerSocket[];
  tokens: string[];
  closes: Array<{ code: number }>;
}

async function startFixture(): Promise<Fixture> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const fixture: Fixture = {
    wss,
    port: (wss.address() as { port: number }).port,
    sockets: [],
    tokens: [],
    closes: [],
  };
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "ws://fixture");
    fixture.sockets.push(socket);
    fixture.tokens.push(url.searchParams.get("token") ?? "");
    socket.on("close", (code) => fixture.closes.push({ code }));
  });
  return fixture;
}

describe("client against a real ws server", () => {
  let fixture: Fixture | undefined;
  const clients: RealtimeClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await new Promise<void>((resolve) => fixture?.wss.close(() => resolve()));
    fixture = undefined;
  });

  const open = async (token = "tok-1") => {
    fixture ??= await startFixture();
    const client = connect(`ws://127.0.0.1:${fixture.port}`, token, {
      baseDelayMs: 20,
      maxDelayMs: 200,
    });
    clients.push(client);
    await waitFor(() => client.state === "open");
    return client;
  };

  it("hands the token to the server exactly as given", async () => {
    await open("dev-secret:tenant-a");
    expect(fixture!.tokens).toEqual(["dev-secret:tenant-a"]);
  });

  it("delivers published envelopes to typed subscribers", async () => {
    const client = await open();
    const seen: number[] = [];
    client.on("sync.progress", (envelope) => seen.push(envelope.data.done));
    fixture!.sockets[0]!.send(encodeEnvelope(progress));
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([2]);
    expect(client.malformedCount).toBe(0);
  });

  it("counts malformed frames without dropping the connection", async () => {
    const client = await open();
    fixture!.sockets[0]!.send("garbage");
    fixture!.sockets[0]!.send(JSON.stringify({ type: "nope", ts: 1, data: {} }));
    await waitFor(() => client.malformedCount === 2);
    expect(client.state).toBe("open");
  });

  it("reconnects after a server-side drop and keeps subscriptions", async () => {
    const client = await open();
    const seen: string[] = [];
    client.on("sync.done", (envelope) => seen.push(envelope.data.source));

    fixture!.sockets[0]!.close(1012); // service restart
    await waitFor(() => client.state === "open" && fixture!.sockets.length === 2);

    fixture!.sockets[1]!.send(
      encodeEnvelope({ type: "sync.done", data: { tenantId: "t1", source: "shopify", ok: true } })
    );
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(["shopify"]);
  });

  it("dispose closes the socket cleanly (1000) on the server side", async () => {
    const client = await open();
    client.dispose();
    await waitFor(() => fixture!.closes.length === 1);
    expect(fixture!.closes[0]!.code).toBe(1000);
    expect(client.state).toBe("closed");
  });

  it("a server 4401 close ends the client without reconnecting", async () => {
    const client = await open();
    fixture!.sockets[0]!.close(4401, "unauthorized");
    await waitFor(() => client.state === "closed");
    await sleep(150); // several base delays: no new connection may appear
    expect(fixture!.sockets).toHaveLength(1);
  });
});
