"use server";

import { revalidatePath } from "next/cache";
import { BUYABLE_PRODUCT_WHERE, Prisma, prismaForTenant, prismaService } from "@wezesha/db";
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
 * and records the ledger. Nothing was written until now.
 *
 * The ledger is per product, matching what a cost typed by hand records. One
 * summary row carrying only counts meant the same change made two ways left two
 * different levels of detail in a trail the screen calls an accounting record:
 * a hand edit said which product and from what to what, an import of two hundred
 * said neither.
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

  // The costs being replaced, read before anything is written — the ledger's
  // "from" side. Tenant-scoped, so a row that isn't this workspace's simply
  // isn't here and its update writes nothing either.
  const previous = new Map(
    (
      await db.product.findMany({
        where: { id: { in: writes.map((w) => w.productId) } },
        select: { id: true, costKes: true, costSource: true },
      })
    ).map((p) => [p.id, p])
  );

  let applied = 0;
  const ledger: Prisma.AuditEventCreateManyInput[] = [];
  for (const w of writes) {
    const res = await db.product.updateMany({
      where: { id: w.productId },
      data: { costKes: w.costKes, costSource: "manual", costUpdatedAt: now, costMovedPct: null, costMovedAt: null },
    });
    applied += res.count;
    if (res.count === 0) continue;
    const was = previous.get(w.productId);
    ledger.push({
      tenantId: ctx.tenantId,
      entity: "Product",
      entityId: w.productId,
      action: "cost_changed",
      actorUserId: ctx.actor.userId,
      actorName: ctx.actor.name,
      meta: {
        field: "costKes",
        from: was?.costKes ?? null,
        to: w.costKes,
        source: "import",
        previousSource: was?.costSource ?? null,
      },
    });
  }

  const result: ApplyResult = {
    applied,
    matched: preview.summary.matched,
    ambiguous: preview.summary.ambiguous,
    unknown: preview.summary.unknown,
    invalid: preview.summary.invalid,
    pinnedSkipped: input.overwritePinned ? 0 : preview.summary.pinned,
  };

  // Per-product rows first, then one row for the import itself. The summary is
  // filed against the workspace rather than against "a product" — it is not a
  // cost change to any one of them, and reading as one was half the confusion.
  if (ledger.length > 0) await prismaService.auditEvent.createMany({ data: ledger });
  await prismaService.auditEvent.create({
    data: {
      tenantId: ctx.tenantId,
      entity: "Tenant",
      entityId: ctx.tenantId,
      action: "cost_import",
      actorUserId: ctx.actor.userId,
      actorName: ctx.actor.name,
      meta: { ...result, overwritePinned: Boolean(input.overwritePinned) },
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
