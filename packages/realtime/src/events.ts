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
    /** Phases COMPLETED so far. Unchanged meaning — old subscribers still work. */
    done: number;
    /** Number of phases in the run. */
    total: number;
    /** Which edge of `phase` this is. Absent means "finished" (older publishers). */
    state?: "started" | "running" | "finished";
    /** Records processed inside `phase` so far. */
    items?: number;
    /** Records expected in `phase`; absent while the count isn't knowable yet. */
    itemsTotal?: number;
    /** The SyncRun this belongs to, so a client can ignore a stale run's tail. */
    runId?: string;
  };
  "sync.done": { tenantId: string; source: string; ok: boolean; runId?: string };
  "forecast.done": { tenantId: string; forecastRunId: string; created: number };
  "pos.ingested": { tenantId: string; salesIngested: number; linesUnmatched: number };
  "notification.new": { tenantId: string; kind: string; title: string };
}

export type RealtimeEventType = keyof RealtimeEventMap;

/** The envelope for one specific event type — what a per-type subscriber receives. */
export type RealtimeEnvelopeOf<K extends RealtimeEventType> = {
  type: K;
  ts: number;
  data: RealtimeEventMap[K];
};

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
  // The optional fields are checked only when present: a publisher that predates
  // them still validates, and an older gateway forwards the widened payload
  // untouched because unknown extras are ignored.
  "sync.progress": (d) =>
    isStr(d.tenantId) &&
    isStr(d.source) &&
    isStr(d.phase) &&
    isNum(d.done) &&
    isNum(d.total) &&
    (d.state === undefined || d.state === "started" || d.state === "running" || d.state === "finished") &&
    (d.items === undefined || isNum(d.items)) &&
    (d.itemsTotal === undefined || isNum(d.itemsTotal)) &&
    (d.runId === undefined || isStr(d.runId)),
  "sync.done": (d) =>
    isStr(d.tenantId) &&
    isStr(d.source) &&
    typeof d.ok === "boolean" &&
    (d.runId === undefined || isStr(d.runId)),
  "forecast.done": (d) => isStr(d.tenantId) && isStr(d.forecastRunId) && isNum(d.created),
  "pos.ingested": (d) => isStr(d.tenantId) && isNum(d.salesIngested) && isNum(d.linesUnmatched),
  "notification.new": (d) => isStr(d.tenantId) && isStr(d.kind) && isStr(d.title),
};

/** Every event type as runtime data, for consumers that fan out per type. */
export const REALTIME_EVENT_TYPES = Object.keys(validators) as readonly RealtimeEventType[];

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
