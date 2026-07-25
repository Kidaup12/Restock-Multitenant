import { prismaForTenant, type LimitState } from "@wezesha/db";
import { hasPermission, type PermissionKey, type PermissionSource } from "@/lib/auth/permissions";
import { evaluateLimits } from "@/lib/limits/evaluate";
import { featureEnabled, type FeatureConfigSource, type FeatureKey } from "./feature-flags";
import {
  planAllows,
  planFeatureTier,
  PLAN_TIER_LABEL,
  type PlanFeature,
} from "./plan-features";
import { setupDepth, type SetupDepth, type SetupLevel } from "./setup-depth";

/**
 * The capability spine — the one place the four gates compose. A capability is
 * available only when ALL of them pass; when several fail, the FIRST in gate
 * order wins and carries its own honest message, so the owner always knows the
 * single next thing to fix and whose decision it is.
 *
 * Gate order (first blocking gate wins):
 *   1. role     — is this person allowed? A hard per-user hide, checked first so
 *                 money-blind staff are never shown an upgrade or a setup nudge
 *                 for something their role forbids.
 *   2. plan     — does the subscription include it? Shown BEFORE setup — the
 *                 spec rule: the plan lock is "the thing they'd buy first", so a
 *                 feature that is both locked and unset shows the lock first.
 *   3. setup    — is the data present? A nudge to add data, never a wall.
 *   4. feature  — is the tenant switch on? If not, the surface is off and a
 *                 Settings entry turns it on.
 *
 * Count limits (product/member/order caps) are a separate plan concern kept in
 * lib/limits (checkLimit) — one central check, deliberately not scattered into
 * per-capability gates here. `limits` still rides in the context for callers
 * that want to show the warning banner alongside a capability.
 */

export type BlockedGate = "role" | "plan" | "setup" | "feature";

export type CapabilityResult = {
  available: boolean;
  blockedGate: BlockedGate | null;
  message: string;
};

/** One capability's requirement across the four axes. Any axis may be omitted —
 *  that gate simply doesn't apply to this capability. */
export type CapabilityRequirement = {
  /** Human label used in messages ("email a PO to a supplier"). */
  label: string;
  /** Gate 3 — the permission the member must hold. */
  permission?: PermissionKey;
  /** Gate 2 — the plan feature the subscription must include. */
  planFeature?: PlanFeature;
  /** One-line value shown with the plan lock ("Move stock between branches
   *  before buying"). Used in the plan message when planFeature is set. */
  planValue?: string;
  /** Gate 1 — the minimum setup depth. */
  setupLevel?: SetupLevel;
  /** Gate 4 — the tenant feature switch. */
  feature?: FeatureKey;
};

export type CapabilityKey =
  | "email_po_to_supplier"
  | "transfers"
  | "view_costs"
  | "run_forecast"
  | "budget_planner";

/**
 * The registry: each capability mapped to its four-gate requirements. The
 * worked example from the spec is `email_po_to_supplier` — role (approve orders)
 * + plan (supplier PO-email) + setup (suppliers on file) + feature (PO-email
 * switch). The tenant-wide setup level stands in for the data precondition; a
 * finer per-PO check ("this supplier has an email") happens at the call site
 * with the actual PO in hand.
 */
export const CAPABILITIES: Record<CapabilityKey, CapabilityRequirement> = {
  email_po_to_supplier: {
    label: "email a PO to a supplier",
    permission: "approve_orders",
    planFeature: "supplier_po_email",
    planValue: "Group a buy list into POs and email suppliers in one click",
    setupLevel: 2,
    feature: "supplier_email",
  },
  transfers: {
    label: "move stock between branches",
    planFeature: "transfers",
    planValue: "Move stock between branches before buying",
    setupLevel: 3,
    feature: "transfers",
  },
  // Money-blind: role + cost data. No plan lock or switch — costs ship on every tier.
  view_costs: {
    label: "see costs and margins",
    permission: "view_costs",
    setupLevel: 1,
  },
  // The Level-0 first-value promise: works from Shopify alone, on every plan.
  run_forecast: {
    label: "run the forecast",
    planFeature: "run_forecast",
    planValue: "A nightly demand forecast and a ranked buy list",
    setupLevel: 0,
  },
  budget_planner: {
    label: "plan a buy against a budget",
    permission: "view_costs",
    planFeature: "budget_planner",
    planValue: "Fit the most important stock into a set budget",
    setupLevel: 1,
  },
};

/** What data the tenant must add to reach each setup level (setup-gate copy). */
const SETUP_NUDGE: Record<SetupLevel, string> = {
  0: "Connect Shopify",
  1: "Add product costs",
  2: "Assign suppliers and lead times",
  3: "Connect a POS feed or add a second location",
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The membership fields the role gate reads. */
export type CapabilityMembership = PermissionSource;

/** Everything the four gates need, resolved once per request. */
export type CapabilityContext = {
  tenantId: string;
  /** Tenant billing plan key (starter/growth/scale; null = starter). */
  plan: string | null;
  membership: CapabilityMembership;
  config: FeatureConfigSource | null;
  setup: SetupDepth;
  limits: LimitState;
};

/**
 * Evaluate one capability against a resolved context. Returns the FIRST blocking
 * gate (in the order above) with its own honest message, or available=true.
 */
export function resolveCapability(
  ctx: CapabilityContext,
  key: CapabilityKey,
): CapabilityResult {
  const req = CAPABILITIES[key];

  // 1 · role — a per-user hide, checked first.
  if (req.permission && !hasPermission(ctx.membership, req.permission)) {
    return {
      available: false,
      blockedGate: "role",
      message: `You don't have permission to ${req.label}.`,
    };
  }

  // 2 · plan — before setup (the plan lock is the thing they'd buy first).
  if (req.planFeature && !planAllows(ctx.plan, req.planFeature)) {
    const tier = PLAN_TIER_LABEL[planFeatureTier(req.planFeature)];
    const value = req.planValue ?? `Unlock ${req.label}`;
    return {
      available: false,
      blockedGate: "plan",
      message: `${value} — unlock on ${tier}.`,
    };
  }

  // 3 · setup — a nudge to add data, once the plan allows it.
  if (req.setupLevel != null && ctx.setup.level < req.setupLevel) {
    return {
      available: false,
      blockedGate: "setup",
      message: `${SETUP_NUDGE[req.setupLevel]} to ${req.label}.`,
    };
  }

  // 4 · feature switch — the surface is simply off until Settings turns it on.
  if (req.feature && !featureEnabled(ctx.config, req.feature)) {
    return {
      available: false,
      blockedGate: "feature",
      message: `${capitalize(req.label)} is switched off — turn it on in Settings.`,
    };
  }

  return {
    available: true,
    blockedGate: null,
    message: `${capitalize(req.label)} is available.`,
  };
}

/**
 * Resolve the shared context once for a request: the tenant plan, feature
 * switches, setup depth, and plan limits — all on the RLS-scoped client. Pass
 * the already-resolved membership (from activeMembership) in; the caller then
 * evaluates as many capabilities as it needs against this one context.
 */
export async function resolveCapabilityContext(
  tenantId: string,
  membership: CapabilityMembership,
): Promise<CapabilityContext> {
  const db = prismaForTenant(tenantId);
  const [tenant, config, setup, limits] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
    db.tenantConfig.findFirst({ select: { featureFlags: true } }),
    setupDepth(tenantId),
    evaluateLimits(tenantId),
  ]);
  return {
    tenantId,
    plan: tenant?.plan ?? null,
    membership,
    config: config ?? null,
    setup,
    limits,
  };
}

/**
 * Resolve just the tenant's billing plan on the RLS-scoped client — for a
 * plan-only feature gate (planAllows) that doesn't need the full four-gate
 * context. null = the entry tier (starter).
 */
export async function getTenantPlan(tenantId: string): Promise<string | null> {
  const tenant = await prismaForTenant(tenantId).tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  });
  return tenant?.plan ?? null;
}

export * from "./setup-depth";
export * from "./feature-flags";
export * from "./plan-features";
