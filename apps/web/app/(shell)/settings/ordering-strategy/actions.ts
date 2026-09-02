"use server";

import { revalidatePath } from "next/cache";
import { prismaForTenant, prismaService } from "@wezesha/db";
import { parseOrderMethod, type OrderMethod } from "@wezesha/forecast";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * Save the buying style for each product group.
 *
 * Its own action rather than a call into saveWorkspaceSettings: that one takes
 * the workspace name, timezone, alert email and dead-stock window together, so
 * saving a strategy through it would mean the strategy page holding — and
 * rewriting — four fields it does not show. A page that silently writes values
 * it never displayed is how a timezone gets reset by someone changing how they
 * buy.
 */

export type OrderingStrategyInput = {
  methodA: string;
  methodB: string;
  methodC: string;
};

export type OrderingStrategyResult = { ok: true } | { ok: false; error: string };

export async function saveOrderingStrategy(
  input: OrderingStrategyInput,
): Promise<OrderingStrategyResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false, error: "You're not in a workspace." };
  if (!hasPermission(membership, "manage_settings")) {
    return { ok: false, error: "You don't have settings access." };
  }

  const methods: Record<"A" | "B" | "C", OrderMethod | null> = {
    A: parseOrderMethod(input.methodA),
    B: parseOrderMethod(input.methodB),
    C: parseOrderMethod(input.methodC),
  };
  if (!methods.A || !methods.B || !methods.C) {
    return { ok: false, error: "Pick a buying style for each group." };
  }

  const db = prismaForTenant(membership.tenantId);
  const before = await db.tenantConfig.findUnique({
    where: { tenantId: membership.tenantId },
    select: { methodA: true, methodB: true, methodC: true },
  });

  const config = { methodA: methods.A, methodB: methods.B, methodC: methods.C };
  await db.tenantConfig.upsert({
    where: { tenantId: membership.tenantId },
    create: { tenantId: membership.tenantId, ...config },
    update: config,
  });

  // Same shape as the workspace audit: a strategy change moves every reorder
  // quantity on the next run, so "who changed the buying style, and from what"
  // is a question someone will ask after a surprising buy list.
  const changed: Record<string, { from: string | null; to: string }> = {};
  for (const key of ["A", "B", "C"] as const) {
    const from = before?.[`method${key}` as const] ?? null;
    // Narrowed above: all three are non-null past the validation guard.
    const to = methods[key] as OrderMethod;
    if (from !== to) changed[`method${key}`] = { from, to };
  }

  if (Object.keys(changed).length > 0) {
    await prismaService.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        entity: "TenantConfig",
        entityId: membership.tenantId,
        action: "ordering_strategy_changed",
        actorUserId: session.user.id,
        actorName: membership.displayName ?? session.user.name ?? session.user.email,
        meta: changed,
      },
    });
  }

  // The summary card on Settings reads the same values.
  revalidatePath("/settings");
  revalidatePath("/settings/ordering-strategy");
  return { ok: true };
}
