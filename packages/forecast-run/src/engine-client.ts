/**
 * HTTP client for the external Python audit-engine (see the reference service in
 * `_ref-inventory-audit-engine`). The engine takes a tenant's raw sales CSV, runs
 * a nested walk-forward model selection, and returns a per-segment routing table
 * naming the model it would champion for each demand segment.
 *
 * This module owns only the wire: it exports the sales CSV from the tenant's own
 * history (mirroring backtest-run.ts's connection handling), POSTs it as a run,
 * polls to a terminal state, and fetches the routing table. Turning the engine's
 * model ids into the TS forecast's DemandMethod champions is onboarding-audit.ts's
 * job — this file never interprets a model name.
 *
 * Configuration is env-only, matching the house style (see SHOPIFY_APP_URL in
 * apps/worker/src/shopify-sync.ts):
 *   AUDIT_ENGINE_URL   — base origin of the engine, e.g. https://audit.internal
 *   AUDIT_ENGINE_TOKEN — optional bearer token, sent as Authorization when set.
 * With no AUDIT_ENGINE_URL the audit is simply not configured (auditEngineConfigured()
 * is false) and the orchestrator no-ops rather than reaching out.
 */
import { prismaForTenantTx } from "@wezesha/db";

// ── Shared contract (matched EXACTLY by onboarding-audit.ts) ─────────────────
/** One segment's routing decision as the engine emitted it — the champion model
 *  id, its fallback, and the validation-block WAPE when the run validated. */
export type RoutingSegment = { champion: string; fallback: string; val_wape: number | null };
/** The engine's whole routing table: a champion model id per demand segment,
 *  plus the run-wide default and floor models. Stored verbatim; the mapping to
 *  DemandMethod champions happens downstream. */
export type RoutingTable = {
  status: string;
  validated: boolean;
  default_champion: string;
  floor_model: string;
  segments: Record<string, RoutingSegment>;
};
/** What runEngineAudit returns: the routing table plus the run identity and tier
 *  the orchestrator persists into TenantConfig.forecastEnginePlan. */
export type EngineAuditResult = { routing: RoutingTable; runId: string; tier: string | null };

// ── Sales history window ─────────────────────────────────────────────────────
/** A year of history feeds the engine — the same window backtest-run.ts replays. */
const HISTORY_DAYS = 365;
const DAY_MS = 86_400_000;

// ── Typed errors the orchestrator branches on with `instanceof` ──────────────
/** The engine ran Phase-0 health checks and refused the data (no-go). */
export class EngineHaltedError extends Error {
  constructor(message = "audit engine halted the run") {
    super(message);
    this.name = "EngineHaltedError";
  }
}
/** The engine started the run but the pipeline threw. */
export class EngineFailedError extends Error {
  constructor(message = "audit engine run failed") {
    super(message);
    this.name = "EngineFailedError";
  }
}
/** The engine could not be reached, gave a bad response, or the poll timed out. */
export class EngineUnreachableError extends Error {
  constructor(message = "audit engine unreachable") {
    super(message);
    this.name = "EngineUnreachableError";
  }
}

// ── Env config ───────────────────────────────────────────────────────────────
/** Base origin of the audit engine, or null when the audit is not configured. */
export function auditEngineUrl(): string | null {
  const raw = process.env.AUDIT_ENGINE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, ""); // no trailing slash — paths are joined with a leading one
}

/** True when AUDIT_ENGINE_URL is set — the only requirement to attempt a run. */
export function auditEngineConfigured(): boolean {
  return auditEngineUrl() !== null;
}

/** Authorization header when a bearer token is configured, else nothing. */
function authHeaders(): Record<string, string> {
  const token = process.env.AUDIT_ENGINE_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Sales CSV export ─────────────────────────────────────────────────────────
/** Quote a CSV field when it holds a comma, quote, or newline (RFC 4180). */
function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build the engine's sales CSV from this tenant's own history.
 *
 * Columns are `date,sku,location,qty,unit_price` — the loader the engine ships
 * aliases these tolerantly, but we emit its canonical names. One row per
 * SalesHistory row over the last year; the sku falls back to the productId when a
 * product carries no sku, so every row maps to a stable series key.
 *
 * The two reads share one connection through prismaForTenantTx, exactly as
 * backtest-run.ts does — a batch through the per-operation client would ask the
 * pool for a connection per query.
 */
export async function exportSalesCsv(
  tenantId: string
): Promise<{ csv: string; rowCount: number; dayCount: number }> {
  const historySince = new Date(Date.now() - HISTORY_DAYS * DAY_MS);

  const { products, sales } = await prismaForTenantTx(
    tenantId,
    async (tx) => ({
      products: await tx.product.findMany({
        where: { active: true },
        select: { id: true, sku: true, priceKes: true },
      }),
      sales: await tx.salesHistory.findMany({
        where: { date: { gte: historySince } },
        select: { productId: true, date: true, quantity: true, locationId: true, revenueKes: true },
      }),
    }),
    { maxWait: 30_000, timeout: 120_000 }
  );

  // productId -> resolved sku (fall back to the id when sku is null/empty).
  const skuByProduct = new Map<string, string>();
  const priceByProduct = new Map<string, number | null>();
  for (const p of products) {
    const sku = p.sku && p.sku.trim() !== "" ? p.sku : p.id;
    skuByProduct.set(p.id, sku);
    priceByProduct.set(p.id, p.priceKes ?? null);
  }

  const lines: string[] = ["date,sku,location,qty,unit_price"];
  const days = new Set<string>();
  for (const row of sales) {
    const isoDate = row.date.toISOString().slice(0, 10); // YYYY-MM-DD
    days.add(isoDate);
    const sku = skuByProduct.get(row.productId) ?? row.productId;
    const location = row.locationId ?? "ALL";
    const price = priceByProduct.get(row.productId);
    const unitPrice = price == null ? "" : String(price);
    lines.push(
      [
        csvEscape(isoDate),
        csvEscape(sku),
        csvEscape(location),
        csvEscape(String(row.quantity)),
        csvEscape(unitPrice),
      ].join(",")
    );
  }

  return { csv: lines.join("\n"), rowCount: sales.length, dayCount: days.size };
}

// ── Run the audit ────────────────────────────────────────────────────────────
const TERMINAL = new Set(["complete", "halted", "failed"]);

type CreateRunResponse = { client: string; run_id: string; status: string };
type StatusResponse = {
  status?: string;
  manifest?: unknown;
  summary?: Record<string, unknown> | null;
  error?: string | null;
};

/** A routing table is well-formed enough to use when it carries a segments map. */
function isRoutingTable(value: unknown): value is RoutingTable {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as RoutingTable).segments === "object" &&
    (value as RoutingTable).segments != null
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineUnreachableError("aborted"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new EngineUnreachableError("aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Ship the sales CSV to the engine, poll to a terminal state, and return the
 * routing table with the run identity and tier.
 *
 * Uses the global FormData/Blob (Node 18+/undici — this monorepo runs modern
 * Node). The status response folds the routing table into `summary.routing`
 * when the run computed models; we use it directly when present, else fetch the
 * dedicated /routing artifact. A halted or failed run throws its typed error; a
 * timeout or any network fault throws EngineUnreachableError so the orchestrator
 * can tell "the shop's data was refused" from "we couldn't reach the engine".
 */
export async function runEngineAudit(opts: {
  salesCsv: string;
  client: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<EngineAuditResult> {
  const base = auditEngineUrl();
  if (base == null) throw new EngineUnreachableError("AUDIT_ENGINE_URL is not set");
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const headers = authHeaders();
  const deadline = Date.now() + timeoutMs;

  // ── Create the run ─────────────────────────────────────────────────────────
  const form = new FormData();
  form.set("sales", new Blob([opts.salesCsv], { type: "text/csv" }), "sales.csv");
  form.set("client", opts.client);
  form.set("with_models", "true");

  let created: CreateRunResponse;
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      body: form,
      headers,
      signal: opts.signal,
    });
    if (res.status !== 202) {
      throw new EngineUnreachableError(`create run returned ${res.status}`);
    }
    created = (await res.json()) as CreateRunResponse;
  } catch (err) {
    if (err instanceof EngineUnreachableError) throw err;
    throw new EngineUnreachableError(
      `could not create audit run: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const { client, run_id: runId } = created;
  if (!client || !runId) {
    throw new EngineUnreachableError("create run response missing client/run_id");
  }

  // ── Poll to a terminal state ───────────────────────────────────────────────
  const statusUrl = `${base}/api/runs/${encodeURIComponent(client)}/${encodeURIComponent(runId)}`;
  for (;;) {
    if (opts.signal?.aborted) throw new EngineUnreachableError("aborted");
    if (Date.now() >= deadline) {
      throw new EngineUnreachableError("audit run timed out");
    }

    let status: StatusResponse;
    try {
      const res = await fetch(statusUrl, { headers, signal: opts.signal });
      if (!res.ok) throw new EngineUnreachableError(`status returned ${res.status}`);
      status = (await res.json()) as StatusResponse;
    } catch (err) {
      if (err instanceof EngineUnreachableError) throw err;
      throw new EngineUnreachableError(
        `could not poll audit run: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const phase = status.status ?? "unknown";
    if (!TERMINAL.has(phase)) {
      await sleep(pollIntervalMs, opts.signal);
      continue;
    }

    if (phase === "halted") {
      throw new EngineHaltedError(status.error ?? "audit engine halted the run");
    }
    if (phase === "failed") {
      throw new EngineFailedError(status.error ?? "audit engine run failed");
    }

    // phase === "complete": prefer the summary-folded routing, else fetch it.
    const tier =
      status.summary && typeof status.summary.routing_tier === "string"
        ? status.summary.routing_tier
        : null;

    const folded = status.summary?.routing;
    if (isRoutingTable(folded)) {
      return { routing: folded, runId, tier };
    }

    const routing = await fetchRoutingTable(base, client, runId, headers, opts.signal);
    return { routing, runId, tier };
  }
}

/** GET the dedicated routing artifact for a completed run. */
async function fetchRoutingTable(
  base: string,
  client: string,
  runId: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<RoutingTable> {
  const url = `${base}/api/runs/${encodeURIComponent(client)}/${encodeURIComponent(runId)}/routing`;
  let body: unknown;
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw new EngineUnreachableError(`routing returned ${res.status}`);
    body = await res.json();
  } catch (err) {
    if (err instanceof EngineUnreachableError) throw err;
    throw new EngineUnreachableError(
      `could not fetch routing table: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!isRoutingTable(body)) {
    throw new EngineUnreachableError("routing table empty or malformed");
  }
  return body;
}
