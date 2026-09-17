"use server";

import { revalidatePath } from "next/cache";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getTenantFeatureOverrides,
  getTenantPlan,
  planAllows,
  planFeatureTier,
  PLAN_TIER_LABEL,
} from "@/lib/capabilities";
import {
  createOrdersForPredictions,
  getBuyList,
  redactBudgetSplit,
  redactBuyList,
  removePlanOverride,
  splitByBudget,
  UnknownProductError,
  upsertPlanOverride,
  type BudgetSplit,
  type BuyList,
  type CreateOrdersResult,
} from "@/lib/data/plan";
// Sanity cap on the cover-days horizon — a year of cover is already well past
// any real ordering decision. Shared with the steppers that offer it.
import { MAX_COVER_DAYS } from "./cover";
// The same pure filter list mode uses, plus its type. Importing these from the
// scope bar (a "use client" module) into this server action is safe: only the
// type and the pure `filterBuyListRows` value are pulled, and scope-actions.ts
// already imports a runtime value (LEAD_BANDS) from the same module server-side.
// The filter touches only row metadata (class/category/supplier/lead) — no cost
// figure enters it — so it is money-blind safe.
import { filterBuyListRows, LEAD_BANDS, type LeadBand, type ScopeSelection } from "./scope-bar";

/**
 * Plan-screen actions. Each re-resolves the caller's session and active
 * membership server-side — the tenant never comes from the client. Row data
 * flows the same way: the budget action re-reads the buy list rather than
 * trusting rows a client submitted.
 */

export type PlanActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const err = <T,>(error: string): PlanActionResult<T> => ({ ok: false, error });

/** Sanity cap — the buy list itself never approaches this. */
const MAX_LINES = 500;

/** Sanity cap on a single override quantity — a real order never approaches it. */
const MAX_OVERRIDE_QTY = 1_000_000;

/** Sanity cap on the sales-push what-if (whole percent). 500% is 6x demand —
 *  well past any real promotion, and the guard against a runaway order size. */
const MAX_UPLIFT_PCT = 500;

/** Keep only the string members of an unknown value — the scope arrives from the
 *  client, so nothing is trusted on the way in. Mirrors scope-actions' guard. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Reconstruct a clean ScopeSelection from whatever the client sent. Same
 * defensive shape as scope-actions' parseSelection: unknown values become empty
 * dimensions and an unknown lead band is dropped, so the applied scope is always
 * one the filter can reason about. A missing/empty scope means "no filter" —
 * `filterBuyListRows` then returns the input list unchanged (whole shop).
 */
function parseScope(raw: unknown): ScopeSelection {
  const rec = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const leadBand = asStringArray(rec.leadBand).filter((v): v is LeadBand =>
    (LEAD_BANDS as readonly string[]).includes(v)
  );
  return {
    abc: asStringArray(rec.abc),
    category: asStringArray(rec.category),
    supplier: asStringArray(rec.supplier),
    leadBand,
  };
}

export async function addToOrder(input: {
  predictionIds: string[];
}): Promise<PlanActionResult<CreateOrdersResult>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");
  if (!hasPermission(membership, "approve_orders")) {
    return err("You don't have ordering access.");
  }

  const ids = input.predictionIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return err("Nothing ticked.");
  if (ids.length > MAX_LINES) return err("Too many lines in one go.");

  const result = await createOrdersForPredictions(membership.tenantId, ids);
  revalidatePath("/plan");
  revalidatePath("/orders");
  return { ok: true, data: result };
}

/**
 * Allocate a cash budget across the buy list, optionally against a days-of-cover
 * target.
 *
 * `coverDays` is optional here: absent means the plan's own horizon, and the
 * split is then exactly what it was before the target existed. When it is set,
 * the list is re-sized on the one engine first (`getBuyList`'s `coverDays` path,
 * the same path the checklist's lens uses) and the budget is spread over that
 * re-sized list — which is what "spend this cash, but stock to this horizon"
 * means. Note the screen itself opens with a target already set, so the common
 * call carries one; absent is the unticked case, not the default view.
 *
 * `scope` is the screen's ABC/category/supplier/lead filter (the ScopeBar). When
 * present it narrows the re-read buy list to the SAME set list mode shows before
 * the budget is spread, so the split funds the filtered rows — "spend this cash
 * over this slice of the shop". An absent or empty scope imposes nothing:
 * `filterBuyListRows` returns the list unchanged, so a shop that sets no filter
 * budgets the whole shop exactly as before. This deliberately replaces the old
 * whole-shop-only behaviour to match the reference app, which filters the budget
 * screen. The scope is validated defensively — it comes from the client.
 */
export async function planBudget(input: {
  budgetKes: number;
  coverDays?: number | null;
  /** The shop's own decision to let must-restock lines push past the cap.
   *  Absent means cap — a budget is a cap unless someone says otherwise. */
  allowOverflow?: boolean;
  /** The screen's ABC/category/supplier/lead filter. Absent/empty = whole shop
   *  (unchanged). Parsed defensively — it comes from the client. */
  scope?: ScopeSelection;
}): Promise<PlanActionResult<BudgetSplit>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");

  // Refuse before allocating, not after. The caller supplies the budget and the
  // funded/deferred partition is a pure function of cost against it, so a
  // money-blind caller could bisect the budget to recover each line's cost from
  // the shape of the answer even with every figure redacted. There is no
  // redacted form of this result — only "no".
  if (!hasPermission(membership, "view_costs")) {
    return err("Budget planning needs cost access.");
  }

  // Gate 2 (plan) re-checked server-side: the budget allocator is a Growth
  // feature, so a crafted call from a Starter tenant can't bypass the UI lock.
  // Overrides ride alongside the plan so an operator grant is honoured and a
  // deny cannot be bypassed.
  const [plan, overrides] = await Promise.all([
    getTenantPlan(membership.tenantId),
    getTenantFeatureOverrides(membership.tenantId),
  ]);
  if (!planAllows(plan, "budget_planner", overrides)) {
    return err(`Budget planner is on the ${PLAN_TIER_LABEL[planFeatureTier("budget_planner")]} plan.`);
  }

  const budget = Number(input.budgetKes);
  if (!Number.isFinite(budget) || budget < 0) return err(`Enter a budget in ${membership.tenant.currency}.`);

  // Absent, null and NaN all mean "no cover target" — the plan's own horizon.
  let coverDays: number | undefined;
  if (input.coverDays != null) {
    coverDays = Math.round(Number(input.coverDays));
    if (!Number.isFinite(coverDays) || coverDays < 1) {
      return err("Pick a cover of at least one day.");
    }
    if (coverDays > MAX_COVER_DAYS) return err("That cover horizon is too long.");
  }

  // The allocator needs real costs, so the fetch is unredacted; what leaves
  // the server is redacted to the caller's own cost visibility.
  const buyList = await getBuyList(membership.tenantId, { canViewCosts: true, coverDays });
  if (!buyList) return err("Run a forecast first — there's nothing to plan yet.");

  // Narrow to the screen's filter before spreading the budget, so the split funds
  // the SAME set list mode shows. An absent/empty scope returns the input list
  // unchanged (whole shop) — so an unfiltered plan is identical to before.
  // `heldBackCount` stays the whole-shop excluded count on purpose: the "N
  // products held back — open the buy list to see why" hint is about products
  // the allocator never saw, a shop-wide data problem, not the current slice.
  const scope = parseScope(input.scope);
  const rows = filterBuyListRows(buyList.rows, scope);

  const split = splitByBudget(rows, budget, {
    strict: !input.allowOverflow,
    heldBackCount: buyList.excluded.length,
  });
  return { ok: true, data: redactBudgetSplit(split, hasPermission(membership, "view_costs")) };
}

/**
 * Re-size the buy list to a chosen days-of-cover horizon — a what-if the owner
 * drives from the checklist. Mirrors `planBudget`: tenant and membership resolve
 * server-side (never a client tenantId), the fetch runs with costs visible so
 * the re-size sees real inputs, and the result is redacted to the caller's own
 * cost visibility on the way out — a money-blind member never receives costs.
 * The re-size itself is the one engine (`getBuyList`'s `coverDays` path), so no
 * sizing math lives here.
 */
export async function planCoverHorizon(input: {
  coverDays: number;
}): Promise<PlanActionResult<BuyList>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");

  const coverDays = Math.round(Number(input.coverDays));
  if (!Number.isFinite(coverDays) || coverDays < 1) {
    return err("Pick a cover of at least one day.");
  }
  if (coverDays > MAX_COVER_DAYS) return err("That cover horizon is too long.");

  // Fetch with costs visible so the re-size runs on real inputs, then redact to
  // the caller's own cost visibility before it leaves the server.
  const buyList = await getBuyList(membership.tenantId, { canViewCosts: true, coverDays });
  if (!buyList) return err("Run a forecast first — there's nothing to plan yet.");

  return { ok: true, data: redactBuyList(buyList, hasPermission(membership, "view_costs")) };
}

/**
 * Re-size the buy list for a sales push — lift expected demand by a whole-percent
 * uplift and let the plan grow to match, so the owner can stock for a
 * promotion/season. Mirrors `planCoverHorizon`: tenant and membership resolve
 * server-side (never a client tenantId), the fetch runs with costs visible so
 * the re-size sees real inputs, and the result is redacted to the caller's own
 * cost visibility on the way out — a money-blind member never receives costs.
 * The re-size itself is the one engine (`getBuyList`'s `demandUplift` path); the
 * percentage becomes a multiplier here and no sizing math lives in this file.
 */
export async function planSalesTarget(input: {
  upliftPct: number;
}): Promise<PlanActionResult<BuyList>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");

  const upliftPct = Math.round(Number(input.upliftPct));
  if (!Number.isFinite(upliftPct) || upliftPct < 0) {
    return err("Enter a sales push of 0% or more.");
  }
  if (upliftPct > MAX_UPLIFT_PCT) return err("That sales push is too large.");

  // A whole-percent lift becomes the demand multiplier the engine re-sizes on:
  // +25% -> 1.25. Zero is a no-op (1x) — the plan comes back unchanged.
  const demandUplift = 1 + upliftPct / 100;

  // Fetch with costs visible so the re-size runs on real inputs, then redact to
  // the caller's own cost visibility before it leaves the server.
  const buyList = await getBuyList(membership.tenantId, { canViewCosts: true, demandUplift });
  if (!buyList) return err("Run a forecast first — there's nothing to plan yet.");

  return { ok: true, data: redactBuyList(buyList, hasPermission(membership, "view_costs")) };
}

/**
 * Override the engine's recommended quantity for one product on the plan. Tenant
 * and actor resolve from the session — never from the client — and the write is
 * gated on the same ordering permission as adding to an order. Keyed on
 * productId, so it survives the nightly re-plan.
 */
export async function setPlanOverride(input: {
  productId: string;
  qty: number;
}): Promise<PlanActionResult<{ productId: string; qty: number }>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");
  if (!hasPermission(membership, "approve_orders")) {
    return err("You don't have ordering access.");
  }

  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  if (!productId) return err("Pick a product to override.");
  const qty = Math.round(Number(input.qty));
  if (!Number.isFinite(qty) || qty < 1) return err("Enter a whole quantity of 1 or more.");
  if (qty > MAX_OVERRIDE_QTY) return err("That quantity is too large.");

  try {
    await upsertPlanOverride(membership.tenantId, {
      productId,
      qty,
      createdByUserId: session.user.id,
      createdByName: membership.displayName ?? null,
    });
  } catch (e) {
    // The product isn't this workspace's — a stale tab or a crafted call, not
    // something the owner can act on. Refuse in their words, don't 500.
    if (e instanceof UnknownProductError) return err("That product isn't in this workspace.");
    throw e;
  }
  revalidatePath("/plan");
  return { ok: true, data: { productId, qty } };
}

/** Clear a product's override — the plan reverts to the engine's quantity. */
export async function clearPlanOverride(input: {
  productId: string;
}): Promise<PlanActionResult<{ productId: string }>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");
  if (!hasPermission(membership, "approve_orders")) {
    return err("You don't have ordering access.");
  }

  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  if (!productId) return err("Pick a product to revert.");

  await removePlanOverride(membership.tenantId, productId);
  revalidatePath("/plan");
  return { ok: true, data: { productId } };
}
