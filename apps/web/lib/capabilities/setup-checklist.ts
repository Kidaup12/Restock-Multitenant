/**
 * The "finish setup" checklist behind the dashboard card.
 *
 * Distinct from `setup-depth`, which answers a different question and keeps
 * answering it: depth decides which capabilities are UNLOCKED, and the app gates
 * behaviour on it. This is the shop's to-do list — the same signals read as work
 * remaining, plus two the ladder has no opinion about (a display name, a chosen
 * plan) because they unlock nothing.
 *
 * Pure: counts in, steps out. The reads live in `setupChecklistInput`.
 */

import { getTenantPlan } from "./index";
import { setupDepth, type SetupDepth } from "./setup-depth";

export type SetupStepId =
  | "displayName"
  | "shopify"
  | "products"
  | "costs"
  | "leadTimes"
  | "plan";

export type SetupStep = {
  id: SetupStepId;
  label: string;
  /** One clause under the label: what it's for, or what is still outstanding. */
  detail: string;
  done: boolean;
  href: string;
  /**
   * Whether THIS caller can do it. A member looking at "Connect Shopify" is
   * reading someone else's job — offering them a link that dead-ends on a
   * permission error is worse than saying who owns it.
   */
  actionable: boolean;
};

export type SetupChecklistInput = {
  /** The signed-in member's own display name. Personal, so always actionable. */
  displayName: string | null;
  shopifyConnected: boolean;
  productsTotal: number;
  /** Products carrying a cost we trust — the buy list ignores the rest. */
  productsWithCost: number;
  /** At least one product has a supplier, so a real lead time exists to plan on. */
  leadTimesSet: boolean;
  planChosen: boolean;
  /** OWNER/ADMIN. Decides `actionable` on every shop-level step. */
  canManageShop: boolean;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The steps in the order a shop works through them, personal first. */
export function buildSetupSteps(input: SetupChecklistInput): SetupStep[] {
  const shop = input.canManageShop;

  return [
    {
      id: "displayName",
      label: "Set your display name",
      detail: input.displayName?.trim() ? "set" : "so the team knows who you are",
      done: Boolean(input.displayName?.trim()),
      href: "/profile",
      // Your own name — nobody else's permission comes into it.
      actionable: true,
    },
    {
      id: "shopify",
      label: "Connect Shopify",
      detail: input.shopifyConnected ? "connected" : "syncs sales and stock automatically",
      done: input.shopifyConnected,
      href: "/settings/connections",
      actionable: shop,
    },
    {
      id: "products",
      label: "Products synced",
      detail:
        input.productsTotal > 0
          ? `${input.productsTotal} ${plural(input.productsTotal, "product", "products")}`
          : "your catalogue arrives with the first sync",
      done: input.productsTotal > 0,
      href: "/stock",
      actionable: shop,
    },
    {
      id: "costs",
      label: "Add product costs",
      detail: costsDetail(input),
      // Nothing priced yet is not "done", and neither is a partly-priced
      // catalogue: the unpriced products are silently off the buy list, which is
      // the whole reason this step is on the list.
      done: input.productsTotal > 0 && input.productsWithCost === input.productsTotal,
      href: "/costs",
      actionable: shop,
    },
    {
      id: "leadTimes",
      label: "Set supplier lead times",
      detail: input.leadTimesSet ? "set" : "how long restocks take to arrive",
      done: input.leadTimesSet,
      href: "/suppliers",
      actionable: shop,
    },
    {
      id: "plan",
      label: "Choose a plan",
      detail: input.planChosen ? "chosen" : "unlocks the budget planner and transfers",
      done: input.planChosen,
      href: "/settings/plan",
      actionable: shop,
    },
  ];
}

function costsDetail(input: SetupChecklistInput): string {
  if (input.productsTotal === 0) return "needed before anything reaches the buy list";
  if (input.productsWithCost === input.productsTotal) {
    return `all ${input.productsTotal} priced`;
  }
  return `${input.productsWithCost} of ${input.productsTotal} priced — the rest are left off the buy list`;
}

export type SetupProgress = { done: number; total: number; percent: number };

/** Whole percent, floored, so a card never says 100% with work outstanding. */
export function setupProgress(steps: SetupStep[]): SetupProgress {
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  return { done, total, percent: total === 0 ? 0 : Math.floor((done / total) * 100) };
}

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
