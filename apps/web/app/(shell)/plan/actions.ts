"use server";

import { revalidatePath } from "next/cache";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import {
  createOrdersForPredictions,
  getBuyList,
  splitByBudget,
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

  const buyList = await getBuyList(membership.tenantId);
  if (!buyList) return err("Run a forecast first — there's nothing to plan yet.");

  return { ok: true, data: splitByBudget(buyList.rows, budget) };
}
