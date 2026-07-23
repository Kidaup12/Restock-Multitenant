/**
 * The realtime wire contract. Everything that crosses Redis pub/sub — and from
 * there the WebSocket gateway to browsers — is one of these events wrapped in
 * an envelope, published on the owning tenant's channel (`tenant:{tenantId}`).
 *
 * Every event's data carries `tenantId`; the gateway forwards a message only
 * when the payload tenant matches the channel tenant, so a publisher bug can't
 * leak one tenant's events to another.
 */

export interface RealtimeEventMap {
  "sync.progress": {
    tenantId: string;
    source: string;
    phase: string;
    done: number;
    total: number;
  };
  "sync.done": { tenantId: string; source: string; ok: boolean };
  "forecast.done": { tenantId: string; forecastRunId: string; created: number };
  "pos.ingested": { tenantId: string; salesIngested: number; linesUnmatched: number };
  "notification.new": { tenantId: string; kind: string; title: string };
}

export type RealtimeEventType = keyof RealtimeEventMap;

/** Discriminated union of every publishable event (envelope minus `ts`). */
export type RealtimeEvent = {
  [K in RealtimeEventType]: { type: K; data: RealtimeEventMap[K] };
}[RealtimeEventType];

/** What actually travels over the wire. `ts` is epoch milliseconds, set at publish. */
export type RealtimeEnvelope = {
  [K in RealtimeEventType]: { type: K; ts: number; data: RealtimeEventMap[K] };
}[RealtimeEventType];

// --- channels ---------------------------------------------------------------

export const TENANT_CHANNEL_PATTERN = "tenant:*";

export function tenantChannel(tenantId: string): string {
  if (!tenantId) throw new Error("tenantChannel: empty tenantId");
  return `tenant:${tenantId}`;
}

/** Inverse of tenantChannel; null for anything that isn't a tenant channel. */
export function tenantIdFromChannel(channel: string): string | null {
  if (!channel.startsWith("tenant:")) return null;
  const tenantId = channel.slice("tenant:".length);
  return tenantId || null;
}

// --- envelope encode / decode -----------------------------------------------

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const validators: {
  [K in RealtimeEventType]: (d: Record<string, unknown>) => boolean;
} = {
  "sync.progress": (d) =>
    isStr(d.tenantId) && isStr(d.source) && isStr(d.phase) && isNum(d.done) && isNum(d.total),
  "sync.done": (d) => isStr(d.tenantId) && isStr(d.source) && typeof d.ok === "boolean",
  "forecast.done": (d) => isStr(d.tenantId) && isStr(d.forecastRunId) && isNum(d.created),
  "pos.ingested": (d) => isStr(d.tenantId) && isNum(d.salesIngested) && isNum(d.linesUnmatched),
  "notification.new": (d) => isStr(d.tenantId) && isStr(d.kind) && isStr(d.title),
};

export function makeEnvelope(event: RealtimeEvent): RealtimeEnvelope {
  return { ...event, ts: Date.now() };
}

export function encodeEnvelope(event: RealtimeEvent): string {
  return JSON.stringify(makeEnvelope(event));
}

/** Parse + validate a wire message. Null for anything malformed or unknown —
 *  consumers drop those rather than forwarding garbage. */
export function decodeEnvelope(raw: string): RealtimeEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type, ts, data } = parsed as Record<string, unknown>;
  if (!isStr(type) || !(type in validators)) return null;
  if (!isNum(ts)) return null;
  if (typeof data !== "object" || data === null) return null;
  if (!validators[type as RealtimeEventType](data as Record<string, unknown>)) return null;
  return parsed as RealtimeEnvelope;
}
