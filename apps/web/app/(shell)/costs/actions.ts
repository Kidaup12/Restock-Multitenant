"use server";

import { revalidatePath } from "next/cache";
import { BUYABLE_PRODUCT_WHERE, prismaForTenant, prismaService } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission, type PermissionKey } from "@/lib/auth/permissions";
import {
  applicableWrites,
  previewCostImport,
  type CostImportPreview,
  type MatchProduct,
} from "@/lib/cost";

/**
 * Costs-screen writes: the CSV/paste import (preview → apply) and dismissing a
 * cost-moved attention row. Permissions re-checked server-side; tenant id from
 * the membership; RLS-scoped writes; audit on the service client.
 *
 * The import re-previews server-side on apply — it never trusts a client-sent
 * plan — so the write is exactly the deterministic outcome of the same rules the
 * preview showed, and applying twice is idempotent.
 */

export type CostsActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string };

const err = (error: string): CostsActionResult<never> => ({ ok: false, error });

async function actorContext(need: PermissionKey[]) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  for (const key of need) if (!hasPermission(membership, key)) return null;
  return {
    tenantId: membership.tenantId,
    actor: {
      userId: session.user.id,
      name: membership.displayName ?? session.user.name ?? session.user.email,
    },
  };
}

async function loadMatchProducts(tenantId: string): Promise<MatchProduct[]> {
  const db = prismaForTenant(tenantId);
  const rows = await db.product.findMany({
    where: { ...BUYABLE_PRODUCT_WHERE },
    select: { id: true, sku: true, title: true, costSource: true },
  });
  return rows;
}

/** Dry-run: classify each row without writing anything (spec §4). */
export async function previewCostImportAction(input: {
  csv: string;
}): Promise<CostsActionResult<CostImportPreview>> {
  const ctx = await actorContext(["view_costs", "manage_settings"]);
  if (!ctx) return err("You don't have cost-editing access in this workspace.");
  if (!input.csv?.trim()) return err("Paste some rows or choose a file first.");

  const preview = previewCostImport(input.csv, await loadMatchProducts(ctx.tenantId));
  if ("error" in preview) return err(preview.error);
  return { ok: true, data: preview };
}

export type ApplyResult = {
  applied: number;
  matched: number;
  ambiguous: number;
  unknown: number;
  invalid: number;
  pinnedSkipped: number;
};

/**
 * Apply the import: re-previews server-side, writes the applicable costs as
 * manual pins (never overwriting an existing pin unless the owner confirmed it),
 * and records one audit row. Nothing was written until now.
 */
export async function applyCostImportAction(input: {
  csv: string;
  overwritePinned?: boolean;
}): Promise<CostsActionResult<ApplyResult>> {
  const ctx = await actorContext(["view_costs", "manage_settings"]);
  if (!ctx) return err("You don't have cost-editing access in this workspace.");
  if (!input.csv?.trim()) return err("Paste some rows or choose a file first.");

  const preview = previewCostImport(input.csv, await loadMatchProducts(ctx.tenantId));
  if ("error" in preview) return err(preview.error);

  const writes = applicableWrites(preview, { overwritePinned: input.overwritePinned });
  const db = prismaForTenant(ctx.tenantId);
  const now = new Date();
  let applied = 0;
  for (const w of writes) {
    const res = await db.product.updateMany({
      where: { id: w.productId },
      data: { costKes: w.costKes, costSource: "manual", costUpdatedAt: now, costMovedPct: null, costMovedAt: null },
    });
    applied += res.count;
  }

  const result: ApplyResult = {
    applied,
    matched: preview.summary.matched,
    ambiguous: preview.summary.ambiguous,
    unknown: preview.summary.unknown,
    invalid: preview.summary.invalid,
    pinnedSkipped: input.overwritePinned ? 0 : preview.summary.pinned,
  };

  await prismaService.auditEvent.create({
    data: {
      tenantId: ctx.tenantId,
      entity: "Product",
      entityId: "-",
      action: "cost_changed",
      actorUserId: ctx.actor.userId,
      actorName: ctx.actor.name,
      meta: { action: "cost_import", ...result, overwritePinned: Boolean(input.overwritePinned) },
    },
  });
  revalidatePath("/costs");
  revalidatePath("/products");
  return { ok: true, data: result, message: `Applied ${applied} cost${applied === 1 ? "" : "s"}.` };
}

/** Acknowledge a cost-moved attention row: clears the alert and re-baselines the
 *  synced-cost signal to the current cost so it won't immediately re-fire. */
export async function dismissCostMovedAction(input: {
  productId: string;
}): Promise<CostsActionResult> {
  const ctx = await actorContext(["manage_settings"]);
  if (!ctx) return err("You don't have settings access in this workspace.");

  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, title: true, costKes: true, costMovedPct: true },
  });
  if (!product) return err("That product no longer exists.");
  if (product.costMovedPct == null) return err("There's no active alert on that product.");

  await db.product.update({
    where: { id: product.id },
    data: { costMovedPct: null, costMovedAt: null, lastSyncedCostKes: product.costKes > 0 ? product.costKes : null },
  });
  await prismaService.auditEvent.create({
    data: {
      tenantId: ctx.tenantId,
      entity: "Product",
      entityId: product.id,
      action: "edited",
      actorUserId: ctx.actor.userId,
      actorName: ctx.actor.name,
      meta: { action: "dismiss_cost_moved", movedPct: product.costMovedPct },
    },
  });
  revalidatePath("/costs");
  revalidatePath("/products");
  return { ok: true, message: `Cleared the cost-moved alert on ${product.title}.` };
}
