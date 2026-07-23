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

/** Growth actions a limit can gate. */
export type LimitedAction = "add_product" | "invite_member";

export type LimitCheck = {
  /** False only when the action's dimension is over AND grace has run out.
   *  Nothing calls this in blocking position yet — this wave warns only; the
   *  enforcement wave wires it into the mutation points. */
  allowed: boolean;
  over: boolean;
  graceLeftDays: number | null;
  /** User-facing explanation when over; null while comfortably within plan. */
  message: string | null;
};

const ACTION_DIMENSION: Record<LimitedAction, "products" | "members"> = {
  add_product: "products",
  invite_member: "members",
};

/** Would this action be within plan? (Warn-only wave: callers surface the
 *  message; only a grace-expired overage reports allowed=false.) */
export async function checkLimit(tenantId: string, action: LimitedAction): Promise<LimitCheck> {
  const state = await evaluateLimits(tenantId);
  const dimension = state[ACTION_DIMENSION[action]];
  if (!dimension.over) {
    return { allowed: true, over: false, graceLeftDays: null, message: null };
  }
  const graceLeftDays = state.graceLeftDays ?? 0;
  return {
    allowed: graceLeftDays > 0,
    over: true,
    graceLeftDays,
    message:
      graceLeftDays > 0
        ? `This workspace is over its plan limit (${dimension.used} of ${dimension.max}). ${graceLeftDays} grace day${graceLeftDays === 1 ? "" : "s"} left.`
        : `This workspace is over its plan limit (${dimension.used} of ${dimension.max}) and the grace period has ended.`,
  };
}
