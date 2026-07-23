import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorEvent, NodeOptions } from "@sentry/node";
import {
  _resetForTests,
  captureError,
  flushObservability,
  initObservability,
  isEnabled,
  scrubEvent,
} from "../src/index";

/**
 * The wrapper's three contracts, proven against a recording transport (no
 * network, no real DSN): env gating (no DSN → complete no-op), tenant/job
 * tagging on captured events, and secret scrubbing via beforeSend.
 */

const TEST_DSN = "https://examplePublicKey@o0.ingest.example.test/0";

// Structural slice of Sentry's envelope tuple ([headers, [[itemHeaders, payload], ...]]);
// the full Envelope type is not re-exported by @sentry/node.
type EnvelopeItem = [{ type?: string }, unknown];
type RecordedEnvelope = [unknown, EnvelopeItem[]];

/** Events extracted from every envelope the fake transport saw. */
function recordedEvents(envelopes: RecordedEnvelope[]): ErrorEvent[] {
  const events: ErrorEvent[] = [];
  for (const envelope of envelopes) {
    for (const item of envelope[1]) {
      if (item[0]?.type === "event") events.push(item[1] as ErrorEvent);
    }
  }
  return events;
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
  return { envelopes, transport };
}

describe("env gating", () => {
  const savedDsn = process.env.SENTRY_DSN;
  beforeEach(() => {
    _resetForTests();
    delete process.env.SENTRY_DSN;
  });
  afterEach(() => {
    if (savedDsn !== undefined) process.env.SENTRY_DSN = savedDsn;
  });

  it("stays a complete no-op without a DSN", async () => {
    const enabled = await initObservability("test-service");
    expect(enabled).toBe(false);
    expect(isEnabled()).toBe(false);
    // Both calls must be safe plain returns.
    captureError(new Error("nobody hears this"), { tenantId: "t_1" });
    await flushObservability();
  });

  it("initializes when a DSN is provided", async () => {
    const { transport } = makeRecorder();
    const enabled = await initObservability("test-service", { dsn: TEST_DSN, transport });
    expect(enabled).toBe(true);
    expect(isEnabled()).toBe(true);
  });
});

describe("tagging", () => {
  let envelopes: RecordedEnvelope[];

  beforeEach(async () => {
    _resetForTests();
    const recorder = makeRecorder();
    envelopes = recorder.envelopes;
    await initObservability("test-service", { dsn: TEST_DSN, transport: recorder.transport });
  });

  it("tags tenantId, jobId, and queue on captured errors", async () => {
    captureError(new Error("sync exploded"), { tenantId: "t_alpha", jobId: "job-9", queue: "sync" });
    await flushObservability();

    const events = recordedEvents(envelopes);
    expect(events.length).toBe(1);
    expect(events[0]?.tags).toMatchObject({
      tenantId: "t_alpha",
      jobId: "job-9",
      queue: "sync",
      service: "test-service",
    });
  });

  it("drops null and undefined tag values instead of sending them", async () => {
    captureError(new Error("no tenant resolvable"), { tenantId: null, jobId: undefined });
    await flushObservability();

    const events = recordedEvents(envelopes);
    expect(events.length).toBe(1);
    expect(events[0]?.tags).not.toHaveProperty("tenantId");
    expect(events[0]?.tags).not.toHaveProperty("jobId");
  });
});

describe("scrubbing (pure)", () => {
  it("strips cookies and credential headers from the request", () => {
    const event = scrubEvent({
      request: {
        cookies: { "better-auth.session_token": "abc" },
        headers: {
          Cookie: "better-auth.session_token=abc",
          Authorization: "Bearer secret-token-value",
          "x-shopify-access-token": "shpat_0123456789abcdef",
          "content-type": "application/json",
        },
      },
    } as unknown as ErrorEvent);

    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers).toEqual({ "content-type": "application/json" });
  });

  it("redacts token-like strings in messages and exception values", () => {
    const event = scrubEvent({
      message: "request with shpat_0123456789abcdefABCDEF failed",
      exception: {
        values: [
          { value: "401 for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload" },
          { value: "hex leak deadbeefdeadbeefdeadbeefdeadbeef01234567" },
        ],
      },
    } as ErrorEvent);

    expect(event.message).toBe("request with [redacted] failed");
    expect(event.exception?.values?.[0]?.value).toBe("401 for [redacted]");
    expect(event.exception?.values?.[1]?.value).toBe("hex leak [redacted]");
  });

  it("redacts stack-frame source context and drops local variables", () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            value: "boom",
            stacktrace: {
              frames: [
                {
                  context_line: 'const token = "shpat_0123456789abcdefABCDEF";',
                  pre_context: ["// setup", 'auth("Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload");'],
                  post_context: ["send(token);"],
                  vars: { token: "shpat_0123456789abcdefABCDEF" },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent);

    const frame = event.exception!.values![0]!.stacktrace!.frames![0]!;
    expect(frame.context_line).toBe('const token = "[redacted]";');
    expect(frame.pre_context).toEqual(["// setup", 'auth("[redacted]");']);
    expect(frame.post_context).toEqual(["send(token);"]);
    expect(frame.vars).toBeUndefined();
  });

  it("leaves ordinary ids (cuids) and prose alone", () => {
    const event = scrubEvent({
      message: "tenant cmg6jys7x0000remc2j9v14qa sync failed after 3 attempts",
    } as ErrorEvent);
    expect(event.message).toBe("tenant cmg6jys7x0000remc2j9v14qa sync failed after 3 attempts");
  });

  it("redacts query strings", () => {
    const event = scrubEvent({
      request: { query_string: "token=deadbeefdeadbeefdeadbeefdeadbeef&page=2" },
    } as unknown as ErrorEvent);
    expect(event.request?.query_string).toBe("token=[redacted]&page=2");
  });
});

describe("scrubbing (through the pipeline)", () => {
  it("applies beforeSend scrubbing to captured errors", async () => {
    _resetForTests();
    const { envelopes, transport } = makeRecorder();
    await initObservability("test-service", { dsn: TEST_DSN, transport });

    captureError(new Error("Shopify rejected shpat_fedcba9876543210"), { tenantId: "t_beta" });
    await flushObservability();

    const events = recordedEvents(envelopes);
    expect(events.length).toBe(1);
    expect(events[0]?.exception?.values?.[0]?.value).toBe("Shopify rejected [redacted]");
    expect(events[0]?.tags).toMatchObject({ tenantId: "t_beta" });
  });
});
