/**
 * Plan tiers for the web app. The definitions live beside the schema in
 * @wezesha/db (src/limits.ts) so the worker's daily limits cron and these
 * request-path checks can never drift — this module is the web-side surface.
 *
 * Tiers (products / members / sales-activity rows per 30d):
 *   starter  500 /  3 /   500
 *   growth  5000 / 10 /  5000
 *   scale  20000 / 25 / 20000
 * Tenant.plan null = starter; Tenant.planLimits overrides per key.
 */
export {
  DEFAULT_PLAN,
  GRACE_DAYS,
  PLAN_TIERS,
  resolvePlanLimits,
} from "@wezesha/db";
export type { LimitKey, PlanLimits, PlanSource } from "@wezesha/db";
