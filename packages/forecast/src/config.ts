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
export function resolveForecastKnobs(cfg?: TenantForecastOverrides | null): ResolvedForecastKnobs {
  return {
    serviceZ: {
      A: cfg?.serviceLevelZA ?? SERVICE_Z_DEFAULTS.A,
      B: cfg?.serviceLevelZB ?? SERVICE_Z_DEFAULTS.B,
      C: cfg?.serviceLevelZC ?? SERVICE_Z_DEFAULTS.C,
    },
    capMultiple: cfg?.orderCapMultiple ?? DEFAULT_CAP_MULTIPLE,
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
