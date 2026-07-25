"use server";

import { revalidatePath } from "next/cache";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import {
  createOrdersForPredictions,
  getBuyList,
  redactBudgetSplit,
  removePlanOverride,
  splitByBudget,
  upsertPlanOverride,
  type BudgetSplit,
  type CreateOrdersResult,
} from "@/lib/data/plan";

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

export async function planBudget(input: {
  budgetKes: number;
}): Promise<PlanActionResult<BudgetSplit>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");

  const budget = Number(input.budgetKes);
  if (!Number.isFinite(budget) || budget < 0) return err("Enter a budget in KES.");

  // The allocator needs real costs, so the fetch is unredacted; what leaves
  // the server is redacted to the caller's own cost visibility.
  const buyList = await getBuyList(membership.tenantId, { canViewCosts: true });
  if (!buyList) return err("Run a forecast first — there's nothing to plan yet.");

  const split = splitByBudget(buyList.rows, budget);
  return { ok: true, data: redactBudgetSplit(split, hasPermission(membership, "view_costs")) };
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

  await upsertPlanOverride(membership.tenantId, {
    productId,
    qty,
    createdByUserId: session.user.id,
    createdByName: membership.displayName ?? null,
  });
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
