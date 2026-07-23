/**
 * Plan tiers and limit math — the pure interpretation of `Tenant.plan` /
 * `Tenant.planLimits` / `TenantConfig.limitsExceededAt`. Lives beside the
 * schema so web (request-path checks via the tenant client) and worker (the
 * limits cron via the service client) share one definition instead of drifting
 * copies. No queries here: callers supply the counts.
 *
 * Tiers are code-defined, not a table — three rows of config with no admin UI
 * yet would be schema for schema's sake. `planLimits` overrides per tenant.
 */

export const GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

export type LimitKey = "maxProducts" | "maxMembers" | "maxOrders30d";

export type PlanLimits = Record<LimitKey, number>;

/**
 * The tiers. Limits are sized so a healthy shop never meets them:
 *  - starter: a single small shop (Wezesha-sized catalog fits comfortably)
 *  - growth:  multi-branch retail with a full catalog
 *  - scale:   the current ceiling; beyond it is a conversation, not a tier
 * maxOrders30d counts sales-activity rows (SalesHistory) in the last 30 days —
 * the ingest/forecast cost driver — not purchase orders.
 */
export const PLAN_TIERS: Record<string, PlanLimits> = {
  starter: { maxProducts: 500, maxMembers: 3, maxOrders30d: 500 },
  growth: { maxProducts: 5_000, maxMembers: 10, maxOrders30d: 5_000 },
  scale: { maxProducts: 20_000, maxMembers: 25, maxOrders30d: 20_000 },
};

/** Plan applied when Tenant.plan is null or names an unknown tier. */
export const DEFAULT_PLAN = "starter";

/** The tenant fields limit resolution reads — assignable from a Prisma row. */
export type PlanSource = {
  plan: string | null;
  planLimits: unknown;
};

/** Effective limits: the plan tier's defaults, with any valid numeric
 *  `planLimits` keys overriding per tenant. */
export function resolvePlanLimits(tenant: PlanSource): PlanLimits {
  const tier = PLAN_TIERS[tenant.plan ?? DEFAULT_PLAN] ?? PLAN_TIERS[DEFAULT_PLAN]!;
  const limits: PlanLimits = { ...tier };
  const overrides = tenant.planLimits;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const key of Object.keys(limits) as LimitKey[]) {
      const value = (overrides as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        limits[key] = value;
      }
    }
  }
  return limits;
}

export type LimitUsage = {
  used: number;
  max: number;
  over: boolean;
};

export type LimitState = {
  products: LimitUsage;
  members: LimitUsage;
  orders30d: LimitUsage;
  /** True when any dimension is over its limit. */
  anyOver: boolean;
  /** Whole days of grace remaining once over (0 = grace exhausted);
   *  null = not over, so no grace clock is running. */
  graceLeftDays: number | null;
};

export type UsageCounts = {
  products: number;
  members: number;
  orders30d: number;
};

/** Whole days of grace left from the first-over timestamp. */
export function graceLeft(limitsExceededAt: Date, now: Date = new Date()): number {
  const elapsed = now.getTime() - limitsExceededAt.getTime();
  return Math.max(0, Math.ceil((GRACE_DAYS * DAY_MS - elapsed) / DAY_MS));
}

/** Assemble the limit state from counts + limits + the grace anchor. */
export function computeLimitState(
  counts: UsageCounts,
  limits: PlanLimits,
  limitsExceededAt: Date | null,
  now: Date = new Date()
): LimitState {
  const dimension = (used: number, max: number): LimitUsage => ({
    used,
    max,
    over: used > max,
  });
  const products = dimension(counts.products, limits.maxProducts);
  const members = dimension(counts.members, limits.maxMembers);
  const orders30d = dimension(counts.orders30d, limits.maxOrders30d);
  const anyOver = products.over || members.over || orders30d.over;
  return {
    products,
    members,
    orders30d,
    anyOver,
    graceLeftDays: anyOver && limitsExceededAt ? graceLeft(limitsExceededAt, now) : anyOver ? GRACE_DAYS : null,
  };
}
