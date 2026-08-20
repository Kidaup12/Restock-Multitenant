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
  /**
   * Whether this caller may see cost facts at all.
   *
   * A step reading "Add product costs — all 30 priced" is a statement ABOUT the
   * shop's cost data, and a fact about cost is still a cost fact even carrying
   * no figure — the same reasoning that took the missing-cost and suspect-cost
   * chips off Stock for this role. /costs is already closed to them and the link
   * is already out of their nav, so this line was the one place a money-blind
   * member was told how much of the catalogue is priced.
   */
  canViewCosts: boolean;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The steps in the order a shop works through them, personal first. */
export function buildSetupSteps(input: SetupChecklistInput): SetupStep[] {
  const shop = input.canManageShop;

  const steps: SetupStep[] = [
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
      href: "/products",
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

  return steps.filter((step) => step.id !== "costs" || input.canViewCosts);
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
