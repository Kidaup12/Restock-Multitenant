import { prismaForTenant } from "@wezesha/db";
import { CHAMPION_DEFAULT, resolveChampions, type DemandMethod } from "@wezesha/forecast";
import {
  auditEngineConfigured,
  exportSalesCsv,
  runEngineAudit,
  EngineHaltedError,
  EngineFailedError,
  type RoutingTable,
} from "./engine-client";

/**
 * Onboarding audit: a one-shot handshake with the external audit-engine that
 * seeds a freshly connected tenant's per-class champions from a real model
 * selection rather than the run-rate default.
 *
 * The flow:
 *   1. Export the tenant's own sales history as the engine's CSV (engine-client).
 *   2. If there's too little history to select on, stop — no engine call.
 *   3. Ship it, poll to a terminal state, and get back a per-segment routing
 *      table (the engine's rich model ids per demand segment).
 *   4. Collapse those segments to A/B/C and map each engine model id down to the
 *      TS forecast's two DemandMethods (run_rate / recent_heavy).
 *   5. Store the raw routing verbatim in TenantConfig.forecastEnginePlan for
 *      audit, and the mapped champions in forecastChampions — the same shape the
 *      monthly backtest writes, so resolveChampions round-trips it and the
 *      nightly forecast dispatches on it with no other change.
 *
 * The mapping (step 4) is deliberately lossy: the TS engine only runs two
 * methods today, so a dozen engine models fold onto them. It is v1 — as the TS
 * forecast learns the richer models, the collapse gets finer. Until then the
 * safe incumbent (run_rate) is the default for anything unrecognized, so a
 * strange model id never silently degrades a class.
 *
 * Single-tenant path: all reads/writes go through the RLS-enforced tenant client,
 * mirroring backtest-run.ts.
 */

// ── Shared contract (matched EXACTLY by engine-client.ts) ────────────────────
/** The result the caller (worker/route) gets back. `ran` is false whenever the
 *  engine was skipped or errored; `reason` says why. `changed` is true only when
 *  the stored champions actually moved. */
export type OnboardingAuditOutcome = {
  ran: boolean;
  tier: string | null;
  changed: boolean;
  reason?: "insufficient_history" | "engine_halted" | "engine_failed" | "engine_unreachable";
};

/** Below this many DISTINCT days of history the engine has nothing to select on;
 *  we don't call it. Overridable per-caller. */
const DEFAULT_MIN_HISTORY_DAYS = 30;

/**
 * Map an audit-engine model id to the TS forecast's DemandMethod.
 *
 * LOSSY BY DESIGN (v1). The TS engine runs exactly two demand methods —
 * `run_rate` (recency-weighted 30/90/365 blend) and `recent_heavy` (a flat
 * trailing month). The engine picks among a dozen models per segment, so this
 * collapses them: reactive / intermittent-leaning models (recency-weighted
 * Poisson, naive-with-drift, naive-last-week) map to `recent_heavy` because they
 * chase recent movement; everything smoother — seasonal-naive, moving averages,
 * median, SES, Theta, ETS, and the combination models — maps to `run_rate`.
 *
 * Anything unrecognized falls back to `run_rate`, the safe incumbent: a model
 * this table has never seen must never quietly hand a class to the more reactive
 * method. Combos (C1, CC01…CC20) are `run_rate` by default — they blend members
 * and read as smooth. Matching is case-insensitive on the id.
 *
 * This is v1 until the TS forecast learns the richer models the engine selects;
 * as it does, the collapse gets finer.
 */
const RECENT_HEAVY_MODELS = new Set<string>([
  // Intermittent + recency-weighted Poisson family
  "m8",
  "m9",
  "m13",
  "m14",
  "m15",
  "m16",
  "m22",
  // Reactive naive family
  "m3", // naive-with-drift
  "m1", // naive last-week
]);

export function engineModelToDemandMethod(modelId: string): DemandMethod {
  const id = (modelId ?? "").trim().toLowerCase();
  // Normalise the M4 moving-average family (M4_4, M4_8, M4_13) to its base id —
  // it is smooth either way, but this keeps the reactive set unambiguous.
  const base = id.startsWith("m4_") ? "m4" : id;
  return RECENT_HEAVY_MODELS.has(base) ? "recent_heavy" : "run_rate";
}

/**
 * Collapse the engine's per-segment champions to A/B/C DemandMethod champions.
 *
 * The engine keys segments as `AX`,`AY`,`AZ`,`BX`,…,`CZ` (ABC × XYZ), plus
 * non-class segments `intermittent`,`new`,`dormant`,`seasonal_2yr`,`ALL`. For
 * each class letter we take the class-prefixed segments (A -> AX/AY/AZ) and pick
 * the champion of the one with the LOWEST val_wape — the segment the engine
 * validated most trustworthily — then map that model id to a DemandMethod. When
 * a class has no prefixed segment we fall back to the `ALL` segment's champion,
 * else the code default.
 *
 * The non-class segments (`intermittent`/`new`/`dormant`/`seasonal_2yr`) don't
 * start with A/B/C, so they never pollute a class — that's intended.
 */
export function segmentChampionsToClasses(
  routing: RoutingTable
): Record<"A" | "B" | "C", DemandMethod> {
  const segments = routing.segments ?? {};
  const all = segments["ALL"];

  const pick = (letter: "A" | "B" | "C"): DemandMethod => {
    let best: { champion: string; val_wape: number } | null = null;
    for (const [key, seg] of Object.entries(segments)) {
      if (!key.startsWith(letter)) continue;
      // A null/absent val_wape can't be compared — treat it as worst so a
      // validated segment always wins over an unvalidated one, but an
      // all-unvalidated class still resolves to some prefixed champion.
      const score = seg.val_wape == null ? Number.POSITIVE_INFINITY : seg.val_wape;
      if (best == null || score < best.val_wape) {
        best = { champion: seg.champion, val_wape: score };
      }
    }
    if (best != null) return engineModelToDemandMethod(best.champion);
    if (all?.champion) return engineModelToDemandMethod(all.champion);
    return CHAMPION_DEFAULT;
  };

  return { A: pick("A"), B: pick("B"), C: pick("C") };
}

/** A stable engine `client` slug from the tenant id: lowercase, non-slug chars
 *  to "-", trimmed to 64. The engine sanitizes too — we pre-sanitize so the
 *  slug we store matches the slug it runs under. */
function clientSlug(tenantId: string): string {
  const cleaned = (tenantId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 64);
  return cleaned || "tenant";
}

/**
 * Run the onboarding audit for a tenant. Never throws for an expected outcome —
 * a missing engine, thin history, or an engine halt/failure all resolve to an
 * OnboardingAuditOutcome with `ran: false` and a reason. Only truly unexpected
 * faults propagate.
 */
export async function runOnboardingAudit(
  tenantId: string,
  opts?: { now?: Date; signal?: AbortSignal; minHistoryDays?: number }
): Promise<OnboardingAuditOutcome> {
  const now = opts?.now ?? new Date();

  // 1. No engine configured -> nothing to reach.
  if (!auditEngineConfigured()) {
    return { ran: false, tier: null, changed: false, reason: "engine_unreachable" };
  }

  // 2. Export the tenant's history; bail before the engine if it's too thin.
  const { csv, rowCount, dayCount } = await exportSalesCsv(tenantId);
  const minDays = opts?.minHistoryDays ?? DEFAULT_MIN_HISTORY_DAYS;
  if (rowCount === 0 || dayCount < minDays) {
    return { ran: false, tier: null, changed: false, reason: "insufficient_history" };
  }

  // 3. Ship it and get the routing table.
  const client = clientSlug(tenantId);
  let routing: RoutingTable;
  let runId: string;
  let tier: string | null;
  try {
    const result = await runEngineAudit({ salesCsv: csv, client, signal: opts?.signal });
    routing = result.routing;
    runId = result.runId;
    tier = result.tier;
  } catch (err) {
    const reason: OnboardingAuditOutcome["reason"] =
      err instanceof EngineHaltedError
        ? "engine_halted"
        : err instanceof EngineFailedError
          ? "engine_failed"
          : "engine_unreachable";
    return { ran: false, tier: null, changed: false, reason };
  }

  // 4 + 5. Map to class champions and persist. Read the prior champions first so
  // we can tell whether anything actually moved (the same reason backtest-run.ts
  // reads them before its upsert).
  const db = prismaForTenant(tenantId);
  const priorConfig = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { forecastChampions: true },
  });
  const prior = resolveChampions(priorConfig?.forecastChampions);
  const classChampions = segmentChampionsToClasses(routing);
  const changed = (["A", "B", "C"] as const).some((c) => prior[c] !== classChampions[c]);

  const enginePlan = {
    tier,
    routing,
    runId,
    client,
    requestedAt: now.toISOString(),
    source: "audit-engine",
  };

  await db.tenantConfig.upsert({
    where: { tenantId },
    create: {
      tenantId,
      forecastEnginePlan: enginePlan,
      forecastChampions: { ...classChampions, auditedAt: now.toISOString() },
    },
    update: {
      forecastEnginePlan: enginePlan,
      forecastChampions: { ...classChampions, auditedAt: now.toISOString() },
    },
  });

  return { ran: true, tier, changed };
}
