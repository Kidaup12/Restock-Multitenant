"use server";

import { revalidatePath } from "next/cache";
import { prismaService } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getTenantPlan,
  planAllows,
  planFeatureTier,
  PLAN_TIER_LABEL,
} from "@/lib/capabilities";
import {
  discardDistributionPlan,
  finaliseDistributionPlan,
  getDistributionProposal,
  saveDistributionPlan,
  updateDistributionPlan,
} from "@/lib/data/transfers";

/**
 * Transfers actions. Each one re-resolves the caller's session and membership
 * server-side — the tenant never comes from the client — and re-checks BOTH
 * gates the screen applies: the ordering permission and the Growth plan feature.
 * The UI lock is a courtesy; these checks are the enforcement.
 *
 * Line data is never accepted from the client either: a save re-derives the
 * proposal from the engine with the submitted source and horizon, so a crafted
 * request can't write quantities the sizing engine never produced.
 */

export type TransferActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const err = <T,>(error: string): TransferActionResult<T> => ({ ok: false, error });

/** Plan names are a label on a list, not free-form content. */
const MAX_NAME_LENGTH = 80;

type Actor = {
  tenantId: string;
  userId: string;
  name: string | null;
  canViewCosts: boolean;
};

/** Session → membership → permission → plan feature, in that order. Returns the
 *  first failure's message so the caller can surface exactly one honest reason. */
async function actorContext(): Promise<{ ok: true; actor: Actor } | { ok: false; error: string }> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false, error: "You're not in a workspace." };
  if (!hasPermission(membership, "approve_orders")) {
    return { ok: false, error: "You don't have permission to move stock between locations." };
  }
  const plan = await getTenantPlan(membership.tenantId);
  if (!planAllows(plan, "transfers")) {
    return {
      ok: false,
      error: `Transfers are on the ${PLAN_TIER_LABEL[planFeatureTier("transfers")]} plan.`,
    };
  }
  return {
    ok: true,
    actor: {
      tenantId: membership.tenantId,
      userId: session.user.id,
      name: membership.displayName ?? session.user.name ?? session.user.email,
      canViewCosts: hasPermission(membership, "view_costs"),
    },
  };
}

function cleanName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

async function audit(actor: Actor, planId: string, action: string, meta: object): Promise<void> {
  await prismaService.auditEvent.create({
    data: {
      tenantId: actor.tenantId,
      entity: "DistributionPlan",
      entityId: planId,
      action,
      actorUserId: actor.userId,
      actorName: actor.name,
      meta,
    },
  });
}

/**
 * Save what the screen is showing as a draft plan. The proposal is rebuilt here
 * with costs visible — the stored quantities are the engine's, and nothing about
 * the caller's cost visibility changes what gets planned.
 */
export async function createTransferPlan(input: {
  fromLocationId: string;
  coverDays: number;
  windowDays?: number;
  name?: string;
}): Promise<TransferActionResult<{ planId: string; lineCount: number }>> {
  const ctx = await actorContext();
  if (!ctx.ok) return err(ctx.error);

  const proposal = await getDistributionProposal(ctx.actor.tenantId, {
    fromLocationId: input.fromLocationId,
    coverDays: input.coverDays,
    windowDays: input.windowDays,
    canViewCosts: true,
  });
  if (!proposal) return err("Pick a location to move stock from — this workspace has nowhere to send it.");
  if (proposal.lines.length === 0) return err("Nothing needs moving at this cover target.");

  const planId = await saveDistributionPlan(ctx.actor.tenantId, proposal, {
    name: cleanName(input.name),
    createdByName: ctx.actor.name,
  });
  await audit(ctx.actor, planId, "created", {
    fromLocationId: proposal.fromLocationId,
    coverDays: proposal.coverDays,
    lines: proposal.lines.length,
    units: proposal.totalUnits,
  });

  revalidatePath("/transfers");
  return { ok: true, data: { planId, lineCount: proposal.lines.length } };
}

/** Rename a draft, and optionally re-size it against today's stock. */
export async function updateTransferPlan(input: {
  planId: string;
  name?: string;
  resize?: { fromLocationId: string; coverDays: number; windowDays?: number };
}): Promise<TransferActionResult<{ planId: string }>> {
  const ctx = await actorContext();
  if (!ctx.ok) return err(ctx.error);
  if (!input.planId) return err("Which plan?");

  let proposal = undefined;
  if (input.resize) {
    proposal =
      (await getDistributionProposal(ctx.actor.tenantId, {
        fromLocationId: input.resize.fromLocationId,
        coverDays: input.resize.coverDays,
        windowDays: input.resize.windowDays,
        canViewCosts: true,
      })) ?? undefined;
    if (!proposal) return err("That location can't send stock anywhere.");
  }

  const updated = await updateDistributionPlan(ctx.actor.tenantId, input.planId, {
    ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
    ...(proposal ? { proposal } : {}),
  });
  if (!updated) return err("That plan is already finalised, or no longer exists.");

  await audit(ctx.actor, input.planId, "edited", {
    renamed: input.name !== undefined,
    resized: Boolean(proposal),
  });
  revalidatePath("/transfers");
  return { ok: true, data: { planId: input.planId } };
}

/** Lock the draft in as the list the shop picks against. */
export async function finaliseTransferPlan(input: {
  planId: string;
}): Promise<TransferActionResult<{ planId: string }>> {
  const ctx = await actorContext();
  if (!ctx.ok) return err(ctx.error);
  if (!input.planId) return err("Which plan?");

  const done = await finaliseDistributionPlan(ctx.actor.tenantId, input.planId);
  if (!done) return err("That plan is already finalised, or no longer exists.");

  await audit(ctx.actor, input.planId, "finalised", {});
  revalidatePath("/transfers");
  return { ok: true, data: { planId: input.planId } };
}

/** Drop a plan the shop isn't going to run. Soft — the record survives. */
export async function discardTransferPlan(input: {
  planId: string;
}): Promise<TransferActionResult<{ planId: string }>> {
  const ctx = await actorContext();
  if (!ctx.ok) return err(ctx.error);
  if (!input.planId) return err("Which plan?");

  const done = await discardDistributionPlan(ctx.actor.tenantId, input.planId);
  if (!done) return err("That plan no longer exists.");

  await audit(ctx.actor, input.planId, "deleted", {});
  revalidatePath("/transfers");
  return { ok: true, data: { planId: input.planId } };
}
