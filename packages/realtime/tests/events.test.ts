import { describe, expect, it } from "vitest";
import {
  TENANT_CHANNEL_PATTERN,
  decodeEnvelope,
  encodeEnvelope,
  makeEnvelope,
  tenantChannel,
  tenantIdFromChannel,
  type RealtimeEvent,
} from "../src/index";

const events: RealtimeEvent[] = [
  {
    type: "sync.progress",
    data: { tenantId: "t1", source: "shopify", phase: "fetch", done: 1, total: 3 },
  },
  {
    type: "sync.progress",
    data: {
      tenantId: "t1",
      source: "shopify",
      phase: "products",
      done: 0,
      total: 3,
      state: "running",
      items: 1240,
      itemsTotal: 5310,
      runId: "run_1",
    },
  },
  { type: "sync.done", data: { tenantId: "t1", source: "shopify", ok: true } },
  { type: "sync.done", data: { tenantId: "t1", source: "shopify", ok: false, runId: "run_1" } },
  { type: "forecast.done", data: { tenantId: "t1", forecastRunId: "fr_1", created: 42 } },
  { type: "pos.ingested", data: { tenantId: "t1", salesIngested: 120, linesUnmatched: 3 } },
  { type: "notification.new", data: { tenantId: "t1", kind: "restock", title: "Buy list ready" } },
];

describe("channel naming", () => {
  it("builds tenant:{tenantId} and inverts it", () => {
    expect(tenantChannel("abc-123")).toBe("tenant:abc-123");
    expect(tenantIdFromChannel("tenant:abc-123")).toBe("abc-123");
  });

  it("rejects empty tenant ids", () => {
    expect(() => tenantChannel("")).toThrow();
    expect(tenantIdFromChannel("tenant:")).toBeNull();
  });

  it("returns null for non-tenant channels", () => {
    expect(tenantIdFromChannel("other:abc")).toBeNull();
    expect(tenantIdFromChannel("tenantabc")).toBeNull();
  });

  it("the psubscribe pattern matches what tenantChannel produces", () => {
    expect(TENANT_CHANNEL_PATTERN).toBe("tenant:*");
    expect(tenantChannel("x").startsWith(TENANT_CHANNEL_PATTERN.slice(0, -1))).toBe(true);
  });
});

describe("envelope encode/decode", () => {
  it.each(events.map((e) => [e.type, e] as const))("round-trips %s", (_type, event) => {
    const decoded = decodeEnvelope(encodeEnvelope(event));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(event.type);
    expect(decoded!.data).toEqual(event.data);
    expect(typeof decoded!.ts).toBe("number");
  });

  it("stamps ts at makeEnvelope time", () => {
    const before = Date.now();
    const env = makeEnvelope(events[0]!);
    expect(env.ts).toBeGreaterThanOrEqual(before);
    expect(env.ts).toBeLessThanOrEqual(Date.now());
  });

  it("rejects malformed JSON, unknown types, and bad payloads", () => {
    expect(decodeEnvelope("not json")).toBeNull();
    expect(decodeEnvelope("42")).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ type: "nope", ts: 1, data: { tenantId: "t" } }))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ type: "sync.done", data: { tenantId: "t" } }))).toBeNull();
    expect(
      decodeEnvelope(JSON.stringify({ type: "sync.done", ts: 1, data: { source: "s", ok: true } }))
    ).toBeNull();
    expect(
      decodeEnvelope(
        JSON.stringify({ type: "sync.progress", ts: 1, data: { tenantId: "t", source: "s", phase: "p", done: "1", total: 3 } })
      )
    ).toBeNull();
  });
});

/**
 * The progress fields were widened after the worker and the gateway had already
 * shipped. Both directions have to keep working across a rolling deploy, so the
 * compatibility is asserted rather than assumed.
 */
describe("sync.progress compatibility", () => {
  const base = { tenantId: "t1", source: "shopify", phase: "products", done: 1, total: 3 };
  const decodeProgress = (data: Record<string, unknown>) =>
    decodeEnvelope(JSON.stringify({ type: "sync.progress", ts: 1, data }));

  it("accepts a payload from a publisher that predates the new fields", () => {
    expect(decodeProgress(base)).not.toBeNull();
  });

  it("keeps every optional field intact through a round-trip", () => {
    const decoded = decodeProgress({
      ...base,
      state: "started",
      items: 0,
      itemsTotal: 500,
      runId: "run_9",
    });
    expect(decoded!.data).toMatchObject({ state: "started", items: 0, itemsTotal: 500, runId: "run_9" });
  });

  it("rejects malformed optionals rather than forwarding them", () => {
    expect(decodeProgress({ ...base, state: "bogus" })).toBeNull();
    expect(decodeProgress({ ...base, items: "12" })).toBeNull();
    expect(decodeProgress({ ...base, itemsTotal: null })).toBeNull();
    expect(decodeProgress({ ...base, runId: 7 })).toBeNull();
  });

  it("ignores extra fields, so a newer publisher survives an older decoder", () => {
    expect(decodeProgress({ ...base, somethingAddedLater: true })).not.toBeNull();
  });
});
