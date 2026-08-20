/**
 * Pure resolution of tenant forecast settings into engine knobs. The caller
 * reads the TenantConfig row (or passes nothing) — this module only maps plain
 * fields onto defaults. Null/absent always means "code default".
 */
import { SERVICE_Z_DEFAULTS } from "./baseline";
import { CHAMPION_DEFAULT, DEFAULT_CAP_MULTIPLE, type DemandMethod } from "./layered";

// ── Per-ABC-class ordering method ────────────────────────────────────────────
// Business-facing choice a merchant makes per class. Recommended defaults:
// A stays in stock (high service), B balanced, C leans on cash (min/max par —
// chasing 95% service on the slow tail just ties up money).
export type OrderMethod = "stay_in_stock" | "balanced" | "lean_cash";
export const ORDER_METHODS: readonly OrderMethod[] = ["stay_in_stock", "balanced", "lean_cash"] as const;
export const METHOD_DEFAULTS: Record<"A" | "B" | "C", OrderMethod> = {
  A: "stay_in_stock",
  B: "balanced",
  C: "lean_cash",
} as const;

/** A method's ordering policy: the service level to target and whether to size
 *  with the calibrated count-distribution cover or the conservative min/max
 *  par. serviceLevel is null for min/max (it doesn't use a cover quantile). */
export type OrderPolicy = { serviceLevel: number | null; rule: "calibrated" | "min_max" };

export function methodToPolicy(method: OrderMethod): OrderPolicy {
  switch (method) {
    case "stay_in_stock": return { serviceLevel: 0.95, rule: "calibrated" };
    case "balanced":      return { serviceLevel: 0.90, rule: "calibrated" };
    case "lean_cash":     return { serviceLevel: null, rule: "min_max" };
  }
}

/** Parse a stored method string; anything unrecognized is null (use default). */
export function parseOrderMethod(v: string | null | undefined): OrderMethod | null {
  return v && (ORDER_METHODS as readonly string[]).includes(v) ? (v as OrderMethod) : null;
}

/** The forecast-relevant slice of a tenant's stored config. All fields
 *  optional/nullable — a missing row resolves to pure defaults. */
export type TenantForecastOverrides = {
  serviceLevelZA?: number | null;
  serviceLevelZB?: number | null;
  serviceLevelZC?: number | null;
  orderCapMultiple?: number | null;
  methodA?: string | null;
  methodB?: string | null;
  methodC?: string | null;
};

export type ResolvedForecastKnobs = {
  serviceZ: { A: number; B: number; C: number };
  capMultiple: number;
  methods: Record<"A" | "B" | "C", OrderMethod>;
};

/** Overlay a tenant's stored overrides on the code defaults. */
/**
 * Bounds on the stored knobs.
 *
 * These columns are deliberately absent from the settings screen — raw
 * statistics are the engine's, not a shop owner's — but nothing stops a value
 * reaching the column another way: the operator console, a support fix, a
 * migration, a settings screen someone adds later. They are nullable Floats
 * with no database constraint, and they were being passed to the engine exactly
 * as stored. A z of -2 produced a NEGATIVE safety stock, which lowers the
 * reorder point instead of raising it; a cap multiple of 0 silently zeroes the
 * entire buy list.
 *
 * z 0.5 ≈ 69% service, 4 ≈ 99.997%. Below the floor the buffer is noise; above
 * the ceiling it is an order nobody placed on purpose.
 */
const Z_MIN = 0.5;
const Z_MAX = 4;
/** A cap below 1 would clamp the forecast under the best month it is capping
 *  against, which is a cap that only ever removes demand. */
const CAP_MIN = 1;
const CAP_MAX = 20;

/** Keep a stored knob inside its bounds; fall back to the default when it is
 *  absent or not a usable number at all (NaN, Infinity). */
function bounded(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function resolveForecastKnobs(cfg?: TenantForecastOverrides | null): ResolvedForecastKnobs {
  return {
    serviceZ: {
      A: bounded(cfg?.serviceLevelZA, Z_MIN, Z_MAX, SERVICE_Z_DEFAULTS.A),
      B: bounded(cfg?.serviceLevelZB, Z_MIN, Z_MAX, SERVICE_Z_DEFAULTS.B),
      C: bounded(cfg?.serviceLevelZC, Z_MIN, Z_MAX, SERVICE_Z_DEFAULTS.C),
    },
    capMultiple: bounded(cfg?.orderCapMultiple, CAP_MIN, CAP_MAX, DEFAULT_CAP_MULTIPLE),
    methods: {
      A: parseOrderMethod(cfg?.methodA) ?? METHOD_DEFAULTS.A,
      B: parseOrderMethod(cfg?.methodB) ?? METHOD_DEFAULTS.B,
      C: parseOrderMethod(cfg?.methodC) ?? METHOD_DEFAULTS.C,
    },
  };
}

/** The ordering policy for a product's ABC class under the resolved methods.
 *  Unclassified products take the C policy. */
export function policyForClass(
  methods: Record<"A" | "B" | "C", OrderMethod>,
  abc: string | null | undefined
): OrderPolicy {
  const cls = abc === "A" || abc === "B" || abc === "C" ? abc : "C";
  return methodToPolicy(methods[cls]);
}

/**
 * The demand method each ABC class won in the last audition.
 *
 * Stored as loose JSON, so every value is checked on the way out: an unknown
 * or missing method falls back to the run rate rather than throwing. A shop
 * that has never been audited forecasts exactly as it did before.
 */
export function resolveChampions(
  stored: unknown
): Record<"A" | "B" | "C", DemandMethod> {
  const raw = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const pick = (cls: "A" | "B" | "C"): DemandMethod =>
    raw[cls] === "run_rate" || raw[cls] === "recent_heavy"
      ? (raw[cls] as DemandMethod)
      : CHAMPION_DEFAULT;
  return { A: pick("A"), B: pick("B"), C: pick("C") };
}

/** The method for a product's ABC class. Unclassified products take C's. */
export function championForClass(
  champions: Record<"A" | "B" | "C", DemandMethod>,
  abc: string | null | undefined
): DemandMethod {
  const cls = abc === "A" || abc === "B" || abc === "C" ? abc : "C";
  return champions[cls];
}
