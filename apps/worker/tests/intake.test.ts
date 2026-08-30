import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startIntake, type IntakeHandle } from "../src/intake";

/**
 * The intake is how a web app hosted on another platform hands work to this
 * worker, so its auth check is the entire security boundary. Every case below
 * asserts a rejection as well as the accepted path: a suite that only proved
 * the correct token works would pass just as happily with the check deleted.
 */

const SECRET = "correct-horse-battery-staple";

let intake: IntakeHandle;
let base: string;

// The intake only reaches the queue/publisher on the authenticated paths, and
// records here let us prove that an unauthorized call never got that far.
const seen: string[] = [];
const queue = {
  add: async (_name: string, data: { tenantId: string }) => {
    seen.push(`enqueue:${data.tenantId}`);
    return { id: "job-1" };
  },
  getJob: async () => null,
} as never;
const publisher = {
  publish: async () => {
    seen.push("publish");
    return 1;
  },
} as never;

beforeAll(async () => {
  intake = await startIntake({ port: 0, secret: SECRET, queue, publisher });
  base = `http://127.0.0.1:${intake.port}`;
});

afterAll(async () => {
  await intake.close();
});

const auth = (token: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

describe("intake authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await fetch(`${base}/internal/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "t1", source: "shopify" }),
    });
    expect(res.status).toBe(401);
    expect(seen).not.toContain("enqueue:t1");
  });

  it("rejects a wrong bearer token", async () => {
    const res = await fetch(`${base}/internal/enqueue`, {
      method: "POST",
      headers: auth("wrong-token-of-same-ish-length"),
      body: JSON.stringify({ tenantId: "t2", source: "shopify" }),
    });
    expect(res.status).toBe(401);
    expect(seen).not.toContain("enqueue:t2");
  });

  it("rejects a token that is a prefix of the real one", async () => {
    const res = await fetch(`${base}/internal/enqueue`, {
      method: "POST",
      headers: auth(SECRET.slice(0, -1)),
      body: JSON.stringify({ tenantId: "t3", source: "shopify" }),
    });
    expect(res.status).toBe(401);
    expect(seen).not.toContain("enqueue:t3");
  });
});

describe("intake routing", () => {
  it("serves liveness without a credential", async () => {
    const res = await fetch(`${base}/internal/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s an unknown path even when authenticated", async () => {
    const res = await fetch(`${base}/internal/nope`, {
      method: "POST",
      headers: auth(SECRET),
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("400s an enqueue with no tenantId", async () => {
    const res = await fetch(`${base}/internal/enqueue`, {
      method: "POST",
      headers: auth(SECRET),
      body: JSON.stringify({ source: "shopify" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s a publish with no event", async () => {
    const res = await fetch(`${base}/internal/publish`, {
      method: "POST",
      headers: auth(SECRET),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("405s a GET on an authenticated path", async () => {
    const res = await fetch(`${base}/internal/enqueue`, { headers: auth(SECRET) });
    expect(res.status).toBe(405);
  });
});
