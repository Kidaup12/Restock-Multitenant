"use server";

import { revalidatePath } from "next/cache";
import { Prisma, prismaForTenant, prismaForTenantTx, prismaService } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { learnedLeadMedianDays } from "@/lib/suppliers/lead-time";

/**
 * Suppliers actions. Every action re-resolves the caller's membership and
 * re-checks manage_settings server-side; the tenant id comes from the
 * membership, never the client. Writes run on the RLS-scoped tenant client (a
 * foreign id resolves to nothing), and the audit row rides the service client so
 * no tenant role can filter it.
 */

export type SupplierActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

const err = (error: string): SupplierActionResult => ({ ok: false, error });

const CURRENCIES = ["KES", "USD", "CNY", "AED"] as const;

async function actorContext() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  if (!hasPermission(membership, "manage_settings")) return null;
  return {
    tenantId: membership.tenantId,
    actor: {
      userId: session.user.id,
      name: membership.displayName ?? session.user.name ?? session.user.email,
    },
  };
}

export type SupplierInput = {
  name: string;
  email?: string | null;
  country?: string | null;
  currency?: string | null;
  supplierGroup?: string | null;
  leadTimeAvgDays?: number | null;
  leadTimeStdDays?: number | null;
  moq?: number | null;
};

/** Normalise + validate a create/edit payload into Prisma data, or an error. */
function parseSupplier(input: SupplierInput):
  | { ok: true; data: {
      name: string;
      email: string | null;
      country: string | null;
      currency: string;
      supplierGroup: string | null;
      leadTimeAvgDays: number | null;
      leadTimeStdDays: number;
      moq: number;
    } }
  | { ok: false; error: string } {
  const name = input.name?.trim();
  if (!name) return { ok: false, error: "Give the supplier a name." };

  const currency = (input.currency ?? "USD").trim().toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    return { ok: false, error: "Currency must be one of KES, USD, CNY or AED." };
  }

  const lead = normInt(input.leadTimeAvgDays);
  if (lead != null && (lead < 0 || lead > 365)) {
    return { ok: false, error: "Lead time should be between 0 and 365 days." };
  }
  const std = normInt(input.leadTimeStdDays) ?? 7;
  if (std < 0 || std > 180) {
    return { ok: false, error: "Lead-time variability should be between 0 and 180 days." };
  }
  const moq = normInt(input.moq) ?? 1;
  if (moq < 1) return { ok: false, error: "Minimum order quantity must be at least 1." };

  return {
    ok: true,
    data: {
      name,
      email: emptyToNull(input.email),
      country: emptyToNull(input.country),
      currency,
      supplierGroup: emptyToNull(input.supplierGroup),
      leadTimeAvgDays: lead,
      leadTimeStdDays: std,
      moq,
    },
  };
}

function normInt(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value);
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function createSupplierAction(input: SupplierInput): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");
  const parsed = parseSupplier(input);
  if (!parsed.ok) return err(parsed.error);

  const db = prismaForTenant(ctx.tenantId);
  const supplier = await db.supplier.create({ data: { tenantId: ctx.tenantId, ...parsed.data } });
  await audit(ctx.tenantId, supplier.id, "created", ctx.actor, { name: supplier.name });
  revalidatePath("/suppliers");
  return { ok: true, message: `Added ${supplier.name}.` };
}

export async function updateSupplierAction(
  input: SupplierInput & { supplierId: string },
): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");
  const parsed = parseSupplier(input);
  if (!parsed.ok) return err(parsed.error);

  const db = prismaForTenant(ctx.tenantId);
  const existing = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) return err("That supplier no longer exists.");

  await db.supplier.update({ where: { id: existing.id }, data: parsed.data });
  await audit(ctx.tenantId, existing.id, "edited", ctx.actor, { name: parsed.data.name });
  revalidatePath("/suppliers");
  return { ok: true, message: `Saved ${parsed.data.name}.` };
}

/**
 * Adopt the learned median lead time as the supplier's typed value. Recomputes
 * the median server-side from receipt history (never trusts a client-sent
 * number), so the write is exactly what the page showed.
 */
export async function adoptLearnedLeadAction(input: {
  supplierId: string;
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const db = prismaForTenant(ctx.tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true, name: true, leadTimeAvgDays: true },
  });
  if (!supplier) return err("That supplier no longer exists.");

  const pos = await db.purchaseOrder.findMany({
    where: {
      supplierId: supplier.id,
      deletedAt: null,
      sentAt: { not: null },
      receivedAt: { not: null },
    },
    select: { sentAt: true, receivedAt: true },
  });
  const learned = learnedLeadMedianDays(
    pos.map((p) => ({ sentAt: p.sentAt!, receivedAt: p.receivedAt! })),
  );
  if (learned == null) return err("Not enough deliveries yet to learn a lead time.");

  await db.supplier.update({ where: { id: supplier.id }, data: { leadTimeAvgDays: learned } });
  await audit(ctx.tenantId, supplier.id, "edited", ctx.actor, {
    field: "leadTimeAvgDays",
    from: supplier.leadTimeAvgDays,
    to: learned,
    source: "learned",
  });
  revalidatePath("/suppliers");
  return { ok: true, message: `${supplier.name} lead time set to ${learned} days.` };
}

/**
 * Assign every unassigned product of one brand (Shopify vendor) to a supplier in
 * a single write. The supplier is resolved on the tenant client so a foreign id
 * is invisible; only products still without a supplier are touched.
 */
export async function bulkAssignByBrandAction(input: {
  vendor: string;
  supplierId: string;
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");
  const vendor = input.vendor?.trim();
  if (!vendor) return err("Pick a brand to assign.");

  const db = prismaForTenant(ctx.tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) return err("Pick a supplier that still exists.");

  const result = await db.product.updateMany({
    where: { vendor, supplierId: null },
    data: { supplierId: supplier.id },
  });
  if (result.count === 0) return err("Those products already have a supplier.");

  await audit(ctx.tenantId, supplier.id, "edited", ctx.actor, {
    action: "bulk_assign_by_brand",
    vendor,
    supplierName: supplier.name,
    products: result.count,
  });
  revalidatePath("/suppliers");
  return { ok: true, message: `Assigned ${result.count} ${vendor} products to ${supplier.name}.` };
}

/**
 * Soft-delete a supplier: the row is kept (deletedAt) so PO history and its
 * scorecard survive, and its products are unlinked so they fall back to
 * category/default timing and are re-flagged as unassigned.
 */
export async function deleteSupplierAction(input: {
  supplierId: string;
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const outcome = await prismaForTenantTx(ctx.tenantId, async (tx) => {
    const supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!supplier) return null;
    const unlinked = await tx.product.updateMany({
      where: { supplierId: supplier.id },
      data: { supplierId: null },
    });
    await tx.supplier.update({ where: { id: supplier.id }, data: { deletedAt: new Date() } });
    return { supplier, unlinked: unlinked.count };
  });
  if (!outcome) return err("That supplier no longer exists.");

  await audit(ctx.tenantId, outcome.supplier.id, "deleted", ctx.actor, {
    name: outcome.supplier.name,
    productsUnlinked: outcome.unlinked,
  });
  revalidatePath("/suppliers");
  return {
    ok: true,
    message:
      outcome.unlinked > 0
        ? `Removed ${outcome.supplier.name}. ${outcome.unlinked} products now need a supplier.`
        : `Removed ${outcome.supplier.name}.`,
  };
}

function audit(
  tenantId: string,
  supplierId: string,
  action: string,
  actor: { userId: string; name: string | null },
  meta: Prisma.InputJsonObject,
): Promise<unknown> {
  return prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "Supplier",
      entityId: supplierId,
      action,
      actorUserId: actor.userId,
      actorName: actor.name,
      meta,
    },
  });
}
