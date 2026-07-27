import { computeLimitState, prismaForTenant, type LimitState } from "@wezesha/db";
import { resolvePlanLimits } from "./config";

/**
 * Request-path plan-limit checks. Read-only: usage counts run on the
 * RLS-enforced tenant client, and the grace anchor (TenantConfig
 * .limitsExceededAt) is only READ here — the worker's daily limits cron owns
 * setting/clearing it, so a page view never mutates billing state.
 */

const DAY_MS = 86_400_000;

/** Current usage vs the tenant's plan: per-dimension {used, max, over} plus
 *  the shared grace countdown (null = not over, no clock running). */
export async function evaluateLimits(tenantId: string, now: Date = new Date()): Promise<LimitState> {
  const db = prismaForTenant(tenantId);
  const since = new Date(now.getTime() - 30 * DAY_MS);

  const [tenant, config, products, members, orders30d] = await Promise.all([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, planLimits: true },
    }),
    db.tenantConfig.findFirst({ select: { limitsExceededAt: true } }),
    db.product.count({ where: { active: true } }),
    db.membership.count(),
    db.salesHistory.count({ where: { date: { gte: since } } }),
  ]);

  const limits = resolvePlanLimits(tenant ?? { plan: null, planLimits: null });
  return computeLimitState(
    { products, members, orders30d },
    limits,
    config?.limitsExceededAt ?? null,
    now
  );
}

/** The countable dimensions a plan caps. */
export type LimitDimension = "products" | "members" | "orders30d";

/** Growth actions a limit can gate. `add_product` has no request-path caller —
 *  nothing in the web app creates a Product; the catalogue only grows through
 *  the worker's Shopify sync, which is not a refusable user action. It stays
 *  declared because the products dimension is real and reported. */
export type LimitedAction = "add_product" | "invite_member";

export type LimitCheck = {
  /** False when the caller must refuse the action. */
  allowed: boolean;
  /** Usage is ALREADY past the cap (it drifted there — see the split below). */
  over: boolean;
  used: number;
  max: number;
  graceLeftDays: number | null;
  /** Plain-language text for the shop owner: the reason when refused, the
   *  heads-up when the plan is nearly full. Null while comfortably within. */
  message: string | null;
};

const ACTION_DIMENSION: Record<LimitedAction, LimitDimension> = {
  add_product: "products",
  invite_member: "members",
};

const DIMENSION_LABEL: Record<LimitDimension, { one: string; many: string }> = {
  products: { one: "product", many: "products" },
  members: { one: "team member", many: "team members" },
  orders30d: {
    one: "sales record in the last 30 days",
    many: "sales records in the last 30 days",
  },
};

function count(n: number, dimension: LimitDimension): string {
  const label = DIMENSION_LABEL[dimension];
  return `${n} ${n === 1 ? label.one : label.many}`;
}

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/**
 * Warn-before-block decision for "can one more fit?", from an already-resolved
 * state — so a caller holding the capability context doesn't re-count.
 *
 * The grace window and the hard refusal cover different causes, and that split
 * is deliberate:
 *  - Usage that DRIFTED past the cap (a Shopify sync pulling more products, a
 *    POS feed pushing more sales rows) isn't something the shop can undo in the
 *    moment, so it keeps the grace days the daily cron already warned about.
 *  - An action that would itself cross the line is refused outright. Nothing is
 *    lost by saying no to the eleventh teammate, and letting it through would
 *    make the tier mean nothing.
 */
export function limitCheck(state: LimitState, dimension: LimitDimension): LimitCheck {
  const { used, max, over } = state[dimension];
  const graceLeftDays = over ? (state.graceLeftDays ?? 0) : null;
  const within = { allowed: true, over: false, used, max, graceLeftDays: null };

  if (used + 1 < max) {
    return { ...within, message: null };
  }
  if (used + 1 === max) {
    return {
      ...within,
      message: `Your plan includes ${count(max, dimension)} — this is the last one.`,
    };
  }
  if (!over) {
    // Exactly at the cap: this action is the one that would cross it.
    return {
      allowed: false,
      over: false,
      used,
      max,
      graceLeftDays: null,
      message: `Your plan includes ${count(max, dimension)} and you're using all of them. Free one up, or ask about moving to a bigger plan.`,
    };
  }
  if (graceLeftDays! > 0) {
    return {
      allowed: true,
      over: true,
      used,
      max,
      graceLeftDays,
      message: `This workspace is over its plan limit — ${count(used, dimension)} against the ${max} your plan includes. You have ${days(graceLeftDays!)} to come back within plan or move to a bigger one.`,
    };
  }
  return {
    allowed: false,
    over: true,
    used,
    max,
    graceLeftDays: 0,
    message: `This workspace has ${count(used, dimension)} but the plan includes ${max}, and the grace period has ended. Come back within plan or move to a bigger one to add more.`,
  };
}

/** Would this action be within plan? Callers refuse on allowed=false and
 *  surface `message` as-is — it is written for a non-technical shop owner. */
export async function checkLimit(
  tenantId: string,
  action: LimitedAction,
  now: Date = new Date()
): Promise<LimitCheck> {
  return limitCheck(await evaluateLimits(tenantId, now), ACTION_DIMENSION[action]);
}
