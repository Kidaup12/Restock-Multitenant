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
  { type: "sync.done", data: { tenantId: "t1", source: "shopify", ok: true } },
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
