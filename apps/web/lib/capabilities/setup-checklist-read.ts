import { getTenantPlan } from "./index";
import { setupDepth, type SetupDepth } from "./setup-depth";
import { buildSetupSteps, type SetupStep } from "./setup-checklist";

/**
 * The database half of the finish-setup checklist, kept apart from the rules it
 * feeds.
 *
 * `setup-checklist.ts` is imported by the card, which is a client component. A
 * server read living in that same module drags `prismaForTenant` — and with it
 * the service-client bootstrap — into the browser bundle, where it throws on
 * `SERVICE_DATABASE_URL` at module evaluation and takes the whole page down
 * with it. The rules stay pure and importable from anywhere; the reads live
 * here.
 */

/**
 * Gather the checklist for a tenant.
 *
 * Reads nothing of its own beyond the plan: `setupDepth` already runs the
 * RLS-scoped pass over connections, products, costs and suppliers, so this
 * composes its facts rather than asking the database the same questions twice.
 * The display name is the caller's own and arrives from the session.
 */
export async function setupChecklistFor(
  tenantId: string,
  { displayName, canManageShop }: { displayName: string | null; canManageShop: boolean }
): Promise<{ steps: SetupStep[]; depth: SetupDepth }> {
  const [depth, plan] = await Promise.all([setupDepth(tenantId), getTenantPlan(tenantId)]);
  const { facts } = depth;

  // The depth goes back with the steps: the caller also needs its pending
  // locations, and asking for it twice would run the whole read pass again.
  const steps = buildSetupSteps({
    displayName,
    // The ladder's `shopify` signal also requires a synced catalogue; here the
    // connection and the catalogue are two separate steps, so this reads the
    // raw fact rather than the rung.
    shopifyConnected: facts.shopifyConnected,
    productsTotal: facts.activeProducts,
    productsWithCost: facts.trustedCostProducts,
    leadTimesSet: facts.suppliedProducts > 0,
    planChosen: plan != null,
    canManageShop,
  });

  return { steps, depth };
}
